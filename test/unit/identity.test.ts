import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import {
  claimIdentity,
  identitySession,
  parseIdentity,
  rememberIdentitySession,
  resolveIdentitySessionFile,
  spawnNamedPi,
  usablePiSessionFile
} from '../../src/runtime/identity.js'

test('named identity: lifetime lock, hostile inputs, child inheritance and isolated cursors', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-identity-')))
  const old = process.env.PI_ACP_DIR
  process.env.PI_ACP_DIR = root
  t.after(() => {
    if (old === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = old
    rmSync(root, { recursive: true, force: true })
  })
  const a = { identityId: randomUUID(), agentDirectory: root }
  const b = { ...a, identityId: randomUUID() }
  const ownerPath = join(root, 'identities', `${a.identityId}.json`)
  for (const bad of [
    { ...a, identityId: '../escape' },
    { ...a, agentDirectory: '.' },
    { ...a, agentDirectory: '/nonexistent/identity' }
  ])
    assert.throws(() => parseIdentity(bad))
  const first = claimIdentity(a, root)
  assert.throws(() => claimIdentity(a, root), /already occupied/)
  const independent = claimIdentity(b, root)
  independent.release()
  first.release()
  // A dead launcher with an unrecorded child is ambiguous, not safe to steal.
  const dead = spawnSync(process.execPath, ['-e', '']).pid!
  writeFileSync(ownerPath, JSON.stringify({ ...a, nonce: 'lost', launcherPid: dead, childPid: null, cwd: root }))
  assert.throws(() => claimIdentity(a, root), /already occupied/)
  writeFileSync(ownerPath, JSON.stringify({ ...a, nonce: 'lost', launcherPid: dead, childPid: dead, cwd: root }))
  const recovered = claimIdentity(a, root)
  recovered.release()
  const guard = join(root, 'identities', `${a.identityId}.guard`)
  mkdirSync(guard)
  assert.throws(() => claimIdentity(a, root), /needs inspection/)
  rmSync(guard, { recursive: true })
  writeFileSync(ownerPath, '{broken')
  assert.throws(() => claimIdentity(a, root))
  rmSync(ownerPath)
  // This is an actual OS process lifetime, independent of ACP connection state.
  const child = spawnNamedPi(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], root, { stdio: 'ignore' }, a)
  try {
    assert.equal(JSON.parse(readFileSync(ownerPath, 'utf8')).childPid, child.pid)
    assert.throws(() => spawnNamedPi(process.execPath, ['-e', ''], root, {}, a), /already occupied/)
    const otherDirectory = join(root, 'other')
    mkdirSync(otherDirectory)
    assert.throws(() => claimIdentity({ ...a, agentDirectory: otherDirectory }, root), /another configuration/)
  } finally {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }
  assert(!existsSync(ownerPath), 'observed process exit releases owner')
  const second = claimIdentity(a, root)
  second.release()
  const adopted = spawnNamedPi(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      `
    import { processIdentity } from ${JSON.stringify(new URL('../../src/runtime/identity.ts', import.meta.url).href)};
    import { spawnSync } from 'node:child_process';
    const identity = processIdentity();
    const nested = spawnSync(process.execPath, ['-e', 'console.log(process.env.PI_ACP_NAMED_OWNER ?? "absent")'], { encoding: 'utf8' });
    console.log(JSON.stringify({ identity, nested: nested.stdout.trim() }));
  `
    ],
    root,
    { stdio: ['ignore', 'pipe', 'pipe'] },
    a
  )
  let result = ''
  adopted.stdout!.on('data', chunk => {
    result += String(chunk)
  })
  await once(adopted, 'close')
  assert.equal(adopted.exitCode, 0)
  assert.equal(JSON.parse(result).identity.identityId, a.identityId)
  assert.equal(JSON.parse(result).nested, 'absent')
  const session = join(root, 'history.jsonl')
  writeFileSync(session, '{"type":"session","id":"01a0bc49-b13d-77d0-9dbc-f49bf02af7ac","cwd":"/tmp"}\n')
  rememberIdentitySession(a, session, randomUUID())
  assert.equal(identitySession(a), session)
  assert.equal(identitySession(b), undefined)
  assert.throws(() => identitySession({ ...a, agentDirectory: join(root, 'other') }), /mismatch/)
})

test('named identity: skip invalid session files and start fresh', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-identity-session-')))
  const old = process.env.PI_ACP_DIR
  process.env.PI_ACP_DIR = root
  const errors: string[] = []
  const orig = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  }
  try {
    const identity = { identityId: randomUUID(), agentDirectory: root }
    const header = '{"type":"session","id":"01a0bc49-b13d-77d0-9dbc-f49bf02af7ac","cwd":"/tmp"}\n'
    const valid = join(root, 'valid.jsonl')
    const empty = join(root, 'empty.jsonl')
    const headless = join(root, 'headless.jsonl')
    const junkThenHeader = join(root, 'repaired.jsonl')
    const objectOnly = join(root, 'object.jsonl')
    writeFileSync(valid, header)
    writeFileSync(empty, '')
    writeFileSync(headless, '{"type":"message","id":"93879ff0","parentId":"5769bf7a"}\n')
    writeFileSync(junkThenHeader, 'not-json\n\n' + header)
    writeFileSync(objectOnly, '{}\n')
    assert.equal(usablePiSessionFile(valid), true)
    assert.equal(usablePiSessionFile(empty), true)
    assert.equal(usablePiSessionFile(headless), false)
    assert.equal(usablePiSessionFile(junkThenHeader), true)
    assert.equal(usablePiSessionFile(objectOnly), false)
    assert.equal(usablePiSessionFile(join(root, 'missing.jsonl')), false)
    rememberIdentitySession(identity, headless, randomUUID())
    assert.equal(identitySession(identity), undefined)
    assert.equal(resolveIdentitySessionFile(identity, headless), undefined)
    assert.equal(resolveIdentitySessionFile(identity, valid), valid)
    assert.equal(existsSync(headless), true, 'must not delete the broken file')
    rememberIdentitySession(identity, valid, randomUUID())
    assert.equal(identitySession(identity), valid)
    assert.equal(resolveIdentitySessionFile(identity, headless), valid, 'cursor wins over invalid fallback')
    rememberIdentitySession(identity, empty, randomUUID())
    assert.equal(identitySession(identity), empty)
    assert(errors.some(line => line.includes(headless)))
  } finally {
    console.error = orig
    if (old === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = old
    rmSync(root, { recursive: true, force: true })
  }
})
