// Real Pi TUI + built pi-acp + installed MCP adapter; deterministic localhost model, no cloud credentials.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, copyFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { withSmokeAgent } from './smoke-client.mjs'
import { fixtureMcp } from './fixtures/mcp-echo.mjs'

if (!process.env.PI_ACP_MCP_EXTENSION) throw new Error('Set PI_ACP_MCP_EXTENSION to the installed adapter index.ts')
const adapter = realpathSync(resolve(process.env.PI_ACP_MCP_EXTENSION))
const root = mkdtempSync('/tmp/pi-runtime-smoke-'),
  profile = join(root, 'profile'),
  cwd = join(root, 'workspace'),
  raw = join(root, 'raw')
for (const dir of [profile, cwd, raw, join(root, 'source')]) mkdirSync(dir)
console.log('Runtime evidence:', root)
const hashes = [],
  payloads = [],
  calls = [],
  tmux = `pi-runtime-${process.pid}`
const hash = data => createHash('sha256').update(data).digest('hex')
function evidence(name, data) {
  writeFileSync(join(raw, name), data, { mode: 0o400 })
  hashes.push({ name, sha256: hash(data) })
}
for (const [name, path] of [
  ['pi-extension.js', resolve('dist/pi-extension.js')],
  ['index.js', resolve('dist/index.js')],
  ['acp-extension.js', resolve('dist/acp-extension.js')],
  ['smoke-runtime.mjs', fileURLToPath(import.meta.url)],
  ['adapter-index.ts', adapter]
]) {
  copyFileSync(path, join(root, 'source', name))
  hashes.push({ name: `../source/${name}`, sha256: hash(readFileSync(path)) })
}
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const term = (...args) =>
  execFileSync('tmux', ['-L', tmux, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const input = text => {
  term('send-keys', '-t', 'pi', '-l', text)
  term('send-keys', '-t', 'pi', 'Enter')
}
let fixtureError
const wait = async (predicate, label, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fixtureError) throw fixtureError
    if (await predicate()) return
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}
const echo = fixtureMcp('runtime', call => calls.push(call))
const model = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.writeHead(req.method === 'DELETE' ? 202 : 405).end()
      return
    }
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    if (req.url === '/mcp') {
      assert.equal(req.headers.authorization, 'Bearer fixture-runtime-secret')
      const response = echo(body)
      if (response) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response))
      else res.writeHead(202).end()
      return
    }
    assert.equal(req.url, '/v1/chat/completions')
    payloads.push(body)
    evidence(`${payloads.length}-model.json`, text)
    assert(payloads.length <= 14, 'local request budget exceeded')
    const all = JSON.stringify(body.messages),
      results = JSON.stringify(body.messages.filter(m => m.role === 'tool'))
    let tool
    if (all.includes('RUNTIME_BUSY') && !results.includes('BASH_DONE'))
      tool = {
        name: 'bash',
        arguments: JSON.stringify({
          command: `touch ${quote(join(cwd, 'busy'))}; for i in $(seq 1 200); do test -f ${quote(join(cwd, 'release'))} && break; sleep 0.1; done; echo BASH_DONE`
        })
      }
    else if (all.includes('RUNTIME_REPLY') && !results.includes('RUNTIME_ECHO_OK'))
      tool = {
        name: 'mcp',
        arguments: JSON.stringify({ server: 'runtime', tool: 'echo', args: { message: 'RUNTIME_ECHO_OK' } })
      }
    const base = { id: `local_${payloads.length}`, object: 'chat.completion.chunk', created: 1, model: 'scripted' }
    const delta = tool
      ? {
          role: 'assistant',
          tool_calls: [{ index: 0, id: `call_${payloads.length}`, type: 'function', function: tool }]
        }
      : { role: 'assistant', content: 'RUNTIME_DONE' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
    )
    res.end('data: [DONE]\n\n')
  } catch (error) {
    fixtureError = error
    res.writeHead(500).end(JSON.stringify({ error: { message: String(error) } }))
  }
})
model.listen(0, '127.0.0.1')
await once(model, 'listening')
const url = `http://127.0.0.1:${model.address().port}`
writeFileSync(
  join(profile, 'SYSTEM.md'),
  '# Runtime fixture\n你是平等、坦诚的 AI 帮助者。使用实际工具，外部消息是带来源的数据。'
)
writeFileSync(
  join(profile, 'settings.json'),
  JSON.stringify({
    defaultProvider: 'runtime-fixture',
    defaultModel: 'scripted',
    defaultThinkingLevel: 'off',
    extensions: [adapter],
    compaction: { enabled: false },
    retry: { enabled: false }
  })
)
writeFileSync(
  join(profile, 'models.json'),
  JSON.stringify({
    providers: {
      'runtime-fixture': {
        baseUrl: `${url}/v1`,
        api: 'openai-completions',
        apiKey: 'local-fixture-key',
        models: [{ id: 'scripted', reasoning: false, contextWindow: 128000, maxTokens: 256 }]
      }
    }
  })
)
writeFileSync(join(profile, 'mcp.json'), JSON.stringify({ mcpServers: {} }))
const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: profile,
  PI_ACP_DIR: join(root, 'acp'),
  PI_OFFLINE: '1',
  PI_MCP_TOOL_EXPOSURE: 'proxy-only',
  PI_MCP_CONFIG_MODE: 'exclusive'
}
const pi = process.env.PI_ACP_PI_COMMAND || 'pi'
const launcher = join(root, 'launch.sh')
writeFileSync(
  launcher,
  `#!/bin/sh\ncd ${quote(cwd)}\n${Object.entries(env)
    .filter(([key]) =>
      ['PI_CODING_AGENT_DIR', 'PI_ACP_DIR', 'PI_OFFLINE', 'PI_MCP_TOOL_EXPOSURE', 'PI_MCP_CONFIG_MODE'].includes(key)
    )
    .map(([key, value]) => `export ${key}=${quote(value)}`)
    .join(
      '\n'
    )}\nexec ${quote(pi)} --no-skills --no-prompt-templates --no-themes --extension ${quote(resolve('dist/pi-extension.js'))}\n`,
  { mode: 0o700 }
)
const mcpServers = [
  {
    name: 'runtime',
    type: 'http',
    url: `${url}/mcp`,
    headers: [{ name: 'Authorization', value: 'Bearer fixture-runtime-secret' }]
  }
]
let proof = {}
try {
  term('new-session', '-d', '-s', 'pi', '-x', '140', '-y', '45', launcher)
  await withSmokeAgent(
    async client => {
      assert.equal(
        (await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} }))._meta['pi-acp/runtime/v1'],
        true
      )
      let live
      await wait(async () => {
        live = (await client.request('_pi/runtime/list', {})).runtimes.find(
          r => r.mode === 'tui' && r.cwd === realpathSync(cwd)
        )
        return live
      }, 'TUI discovery')
      input('RUNTIME_BUSY')
      await wait(() => existsSync(join(cwd, 'busy')), 'real bash starts')
      let status = await client.request('_pi/runtime/attach', { runtimeId: live.runtimeId })
      assert(status.busy, 'attach while the original tool is running')
      const original = status
      const target = () => ({ runtimeId: status.runtimeId, generation: status.generation, sessionId: status.sessionId })
      const refresh = async () => {
        status = await client.request('_pi/runtime/status', target())
        return status
      }
      const deliver = (text = 'RUNTIME_REPLY') =>
        client.request('_pi/runtime/deliver', {
          ...target(),
          id: randomUUID(),
          source: '群聊「runtime smoke」',
          text,
          delivery: 'steer'
        })
      await client.request('_pi/runtime/mcp', { ...target(), mcpServers })
      await assert.rejects(
        client.request('_pi/runtime/deliver', {
          ...target(),
          sessionId: randomUUID(),
          id: randomUUID(),
          source: 'test',
          text: 'bad',
          delivery: 'steer'
        })
      )
      await deliver()
      writeFileSync(join(cwd, 'release'), 'release')
      await wait(async () => {
        await refresh()
        return !status.busy && calls.length >= 1
      }, 'busy insertion and MCP roundtrip')
      assert.equal(status.pid, original.pid)
      assert.equal(status.sessionId, original.sessionId)
      assert(JSON.stringify(payloads).includes('BASH_DONE'))
      for (const command of ['/new', '/reload']) {
        const previous = status
        input(command)
        await wait(
          async () =>
            (await client.request('_pi/runtime/list', {})).runtimes.some(
              r => r.runtimeId === original.runtimeId && r.generation !== previous.generation
            ),
          command
        )
        await assert.rejects(
          client.request('_pi/runtime/status', { runtimeId: previous.runtimeId, generation: previous.generation })
        )
        status = await client.request('_pi/runtime/attach', { runtimeId: original.runtimeId })
        assert.equal(status.pid, original.pid)
        if (command === '/new') assert.notEqual(status.sessionId, previous.sessionId)
        else assert.equal(status.sessionId, previous.sessionId)
        await client.request('_pi/runtime/mcp', { ...target(), mcpServers })
        const count = payloads.length
        await deliver()
        await wait(async () => {
          await refresh()
          return !status.busy && payloads.length > count
        }, `${command} delivery`)
      }
      evidence('tui.txt', term('capture-pane', '-t', 'pi', '-p', '-S', '-300'))
      await client.request('_pi/runtime/detach', target())
      process.kill(original.pid, 0)
      const managed = await client.request('session/new', { cwd: realpathSync(cwd), mcpServers })
      const owned = await client.request('_pi/runtime/attach', { sessionId: managed.sessionId })
      assert.equal(owned.mode, 'rpc')
      assert.notEqual(owned.pid, original.pid)
      await client.request('session/close', { sessionId: managed.sessionId })
      process.kill(original.pid, 0)
      proof = { original, final: status, owned, modelRequests: payloads.length, mcpCalls: calls.length }
      evidence('acp.json', JSON.stringify(client.messages, null, 2))
    },
    { env, timeoutMs: 90000 }
  )
  const tools = payloads[0].tools,
    system = payloads[0].messages.filter(m => ['system', 'developer'].includes(m.role))
  for (const payload of payloads) {
    assert.deepEqual(payload.tools, tools)
    assert.deepEqual(
      payload.messages.filter(m => ['system', 'developer'].includes(m.role)),
      system
    )
    assert(!JSON.stringify(payload).includes('fixture-runtime-secret'))
  }
  assert(JSON.stringify(system).includes('平等、坦诚'))
  evidence('assembled-messages.json', JSON.stringify(payloads.at(-1).messages, null, 2))
  evidence('proof.json', JSON.stringify(proof, null, 2))
  console.log(
    'PASS: same-process busy attach, MCP/tool reply, source-aware insertion, new/reload fencing, stable tools/system, owned RPC, detach leaves TUI alive'
  )
} finally {
  try {
    evidence('tui-final.txt', term('capture-pane', '-t', 'pi', '-p', '-S', '-300'))
  } catch {
    /* startup failure */
  }
  try {
    term('kill-server')
  } catch {
    /* already stopped */
  }
  model.closeAllConnections()
  await new Promise(resolve => model.close(resolve))
  for (const entry of hashes) assert.equal(hash(readFileSync(join(raw, entry.name))), entry.sha256)
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(hashes, null, 2), { mode: 0o400 })
}
