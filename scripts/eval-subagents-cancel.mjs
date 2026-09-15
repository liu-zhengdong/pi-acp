import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { withSmokeAgent } from './smoke-client.mjs'

// Explicitly opt-in local stock-package evaluation; no installed source is changed.
const stock = resolve(process.env.PI_ACP_EVAL_SUBAGENTS ?? join(homedir(), '.pi/agent/npm/node_modules/pi-subagents'))
assert.equal(JSON.parse(await readFile(join(stock, 'package.json'), 'utf8')).version, '0.67.0')
const pi = process.env.PI_ACP_EVAL_PI ?? execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()
const root = await mkdtemp(join(tmpdir(), 'pi-acp-stock-cancel-'))
const fixture = resolve('scripts/fixtures/subagents-cancel-provider.ts')
const wrapper = join(root, 'pi-wrapper.mjs')
const checks = []
const acpMessages = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const records = async () =>
  (await readFile(join(root, 'stock.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(JSON.parse)
const wait = async predicate => {
  const deadline = Date.now() + 15000
  for (;;) {
    const found = await predicate(await records())
    if (found) return found
    assert.ok(Date.now() < deadline, 'Expected stock host evidence before test deadline')
    await sleep(5)
  }
}
try {
  await mkdir(join(root, 'agent', 'agents'), { recursive: true })
  await mkdir(join(root, 'tmp'))
  await writeFile(
    join(root, 'agent', 'settings.json'),
    JSON.stringify({
      defaultProvider: 'stock-eval',
      defaultModel: 'local',
      subagents: {
        intercomBridge: { mode: 'off' },
        completionBatch: { enabled: true, debounceMs: 150, maxWaitMs: 1000 }
      }
    })
  )
  for (const name of ['eval-root', 'eval-leaf'])
    await writeFile(
      join(root, 'agent', 'agents', `${name}.md`),
      `---\nname: ${name}\ndescription: Isolated deterministic product test\nmodel: stock-eval/local\ntools: ${name === 'eval-root' ? 'subagent' : 'read'}\nextensions: ${fixture}\n---\nOnly the deterministic provider executes this test.\n`
    )
  await writeFile(
    wrapper,
    `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
if (!args.includes('--version')) args.push('--extension', ${JSON.stringify(fixture)}, '--extension', ${JSON.stringify(join(stock, 'index.ts'))});
const child = spawn(${JSON.stringify(pi)}, args, {stdio: 'inherit'});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code ?? 1));
`,
    { mode: 0o755 }
  )
  const scenarios = ['delivery', 'nested']
  if (process.env.PI_ACP_EVAL_SCENARIO) assert.ok(scenarios.includes(process.env.PI_ACP_EVAL_SCENARIO))
  for (const scenario of scenarios.filter(
    value => !process.env.PI_ACP_EVAL_SCENARIO || value === process.env.PI_ACP_EVAL_SCENARIO
  )) {
    await rm(join(root, 'release-leaf'), { force: true })
    const before = (await records()).length
    await withSmokeAgent(
      async client => {
        acpMessages.push(client.messages)
        await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
        const { sessionId } = await client.request('session/new', { cwd: root, mcpServers: [] })
        const parent = await wait(rows => rows.slice(before).find(row => row.event === 'session'))
        let settled = false
        let settledAt = 0
        const prompt = client
          .request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: scenario === 'delivery' ? 'STOCK_LAUNCH' : 'STOCK_LAUNCH_NESTED' }]
          })
          .then(result => {
            settled = true
            settledAt = Date.now()
            return result
          })
        const launched = await wait(rows =>
          rows
            .slice(before)
            .find(row => row.event === 'tool_result' && row.sessionId === parent.sessionId && row.details?.asyncId)
        )
        const id = launched.details.asyncId
        if (scenario === 'delivery') {
          assert.ok(launched.details.asyncDir.startsWith(join(root, 'tmp')), 'stock job directory must be isolated')
          const terminal = await wait(async rows => {
            const status = JSON.parse(
              await readFile(join(launched.details.asyncDir, 'status.json'), 'utf8').catch(() => '{}')
            )
            const host = rows
              .slice(before)
              .findLast(row => row.event === 'snapshot' && row.sessionId === parent.sessionId)
            return status.state === 'complete' && host?.live ? { status, host } : undefined
          })
          assert.equal(settled, false, 'real stock terminal root remains held through pending delivery')
          checks.push({
            scenario,
            assertion: 'terminal root with host liveness held ACP open',
            evidence: terminal,
            passed: true
          })
        } else {
          const leaf = await wait(rows => rows.slice(before).find(row => row.event === 'leaf-live'))
          assert.equal(settled, false)
          checks.push({ scenario, assertion: 'actual stock nested child is live', evidence: leaf, passed: true })
          await wait(rows =>
            rows
              .slice(before)
              .find(
                row =>
                  row.event === 'snapshot' &&
                  row.sessionId === parent.sessionId &&
                  row.live &&
                  row.reply?.data?.asyncSnapshot?.runs?.some(
                    run => run.id === id && run.state === 'complete' && JSON.stringify(run.children).includes('running')
                  )
              )
          )
          assert.equal(settled, false, 'terminal root with live descendant must retain the ACP turn')
        }
        const cancelAt = Date.now()
        client.notify('session/cancel', { sessionId })
        assert.equal((await prompt).stopReason, 'cancelled')
        assert.ok(settledAt - cancelAt < 11000, 'the ten-second cancellation budget must not restart')
        const warning = client.updates.some(
          update =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content?.text?.includes('detached work may still be running')
        )
        const after = (await records()).slice(before)
        assert.equal(
          warning,
          false,
          'verified nested work and finite delivery must drain within the unchanged deadline'
        )
        checks.push({
          scenario,
          assertion: 'quiescence confirmed within the existing cancellation budget',
          elapsedMs: settledAt - cancelAt,
          warning,
          passed: true
        })
        if (scenario === 'nested') {
          const leafEnd = after.find(row => row.event === 'leaf-settled')
          assert.ok(leafEnd, 'nested execution must settle before ACP cancellation, not only acknowledge interrupt')
          assert.equal(leafEnd.aborted, true)
          assert.equal(leafEnd.gateReleased, false)
          assert.ok(leafEnd.at <= settledAt, 'leaf execution must settle before the ACP cancellation response')
          const interrupt = after.find(row => row.event === 'interrupt-reply')
          assert.equal(interrupt?.request.source?.extension, 'pi-acp', 'only the adapter issues nested interrupt')
          assert.equal(interrupt?.reply.success, true)
          checks.push({
            scenario,
            assertion: 'adapter public interrupt quiesced the nested execution before ACP response',
            evidence: { leafEnd, interrupt, settledAt },
            passed: true
          })
          const terminalWithLiveNested = after.find(
            row =>
              row.event === 'snapshot' &&
              row.sessionId === parent.sessionId &&
              row.live &&
              row.reply?.data?.asyncSnapshot?.runs?.some(
                run =>
                  run.id === id &&
                  ['complete', 'stopped', 'paused'].includes(run.state) &&
                  JSON.stringify(run.children).includes('running')
              )
          )
          assert.ok(terminalWithLiveNested, 'stock terminal root must coexist with its live nested descendant')
          checks.push({
            scenario,
            observation: 'terminal root/live nested descendant handled by adapter public interrupt',
            reproduced: true,
            evidence: terminalWithLiveNested
          })
        }
        await client.request('session/close', { sessionId })
      },
      {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          XDG_CONFIG_HOME: root,
          PI_CODING_AGENT_DIR: join(root, 'agent'),
          PI_ACP_PI_COMMAND: wrapper,
          PI_ACP_STOCK_ROOT: root,
          TMPDIR: join(root, 'tmp'),
          TMP: join(root, 'tmp'),
          TEMP: join(root, 'tmp')
        }
      }
    )
  }
  console.log(JSON.stringify(checks, null, 2))
} finally {
  await writeFile(join(root, 'release-leaf'), 'release')
  const rows = await records()
  const runnerPidSources = []
  for (const dir of new Set(
    rows
      .filter(row => row.event === 'tool_result')
      .map(row => row.details?.asyncDir)
      .filter(Boolean)
  )) {
    assert.ok(dir.startsWith(join(root, 'tmp') + '/'), 'only this isolated test owns these runner artifacts')
    const statusPath = join(dir, 'status.json')
    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    if (Number.isInteger(status.pid) && status.pid > 0) runnerPidSources.push({ statusPath, pid: status.pid })
  }
  const pids = [...new Set([...rows.map(row => row.pid), ...runnerPidSources.map(source => source.pid)])]
  const deadline = Date.now() + 15000
  const isLive = pid => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') return false
      throw error
    }
  }
  while (pids.some(isLive) && Date.now() < deadline) await sleep(25)
  const livePids = pids.filter(isLive)
  checks.push({
    assertion: 'all recorded isolated Pi/runner processes exited',
    pids,
    runnerPidSources,
    livePids,
    passed: livePids.length === 0
  })
  const destination = process.env.PI_ACP_EVAL_LOG_DIR
  if (destination) {
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'stock-trace.jsonl'), await readFile(join(root, 'stock.jsonl')).catch(() => ''))
    await writeFile(join(destination, 'stock-checks.json'), JSON.stringify(checks, null, 2) + '\n')
    await writeFile(
      join(destination, 'stock-acp-trace.jsonl'),
      acpMessages
        .flat()
        .map(row => JSON.stringify(row))
        .join('\n') + '\n'
    )
  }
  // Keep local upstream evidence; do not delete artifacts under a finishing runner.
  console.error(`Stock evaluation artifacts retained: ${root}`)
  assert.deepEqual(livePids, [], 'no isolated runtime may be left alive')
}
