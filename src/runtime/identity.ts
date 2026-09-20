import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { getPiAcpDir } from '../acp/paths.js'
import { buildPiInvocation, getPiCommand } from '../pi-rpc/command.js'

export type NamedIdentity = { identityId: string; agentDirectory: string }
type Owner = NamedIdentity & { nonce: string; launcherPid: number; childPid: number | null; cwd: string }
type Cursor = NamedIdentity & { sessionFile: string | null; runtimeId: string }
const bindingKey = Symbol.for('@liuser/pi-acp/named-identity/v1')
export const IDENTITY_CAPABILITY = 'pi-acp/identity/v1'
const ENV = 'PI_ACP_NAMED_OWNER'

export function parseIdentity(value: unknown): NamedIdentity {
  if (!value || typeof value !== 'object') throw new Error('Invalid named identity')
  const { identityId, agentDirectory } = value as Partial<NamedIdentity>
  if (typeof identityId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identityId))
    throw new Error('Invalid identityId')
  if (typeof agentDirectory !== 'string' || !isAbsolute(agentDirectory) || !statSync(agentDirectory).isDirectory())
    throw new Error('agentDirectory must be an existing absolute directory')
  return { identityId, agentDirectory: realpathSync(agentDirectory) }
}
function files(identity: NamedIdentity) {
  const root = join(getPiAcpDir(), 'identities')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const base = join(root, identity.identityId)
  return { owner: `${base}.json`, guard: `${base}.guard`, cursor: `${base}.cursor.json` }
}
function writeAtomic(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  renameSync(temp, path)
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owner PID; refusing takeover')
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
  }
}
/** No time-based expiry: an unresponsive process still owns its identity. */
export function claimIdentity(value: NamedIdentity, cwd: string) {
  const identity = parseIdentity(value),
    paths = files(identity)
  const guarded = <T>(fn: () => T): T => {
    try {
      mkdirSync(paths.guard, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      throw new Error(
        `Identity ownership is being changed or needs inspection: ${paths.guard}; no second Pi was started`
      )
    }
    try {
      return fn()
    } finally {
      rmdirSync(paths.guard)
    }
  }
  const owner: Owner = { ...identity, nonce: randomUUID(), launcherPid: process.pid, childPid: null, cwd }
  guarded(() => {
    if (existsSync(paths.owner)) {
      const previous = JSON.parse(readFileSync(paths.owner, 'utf8')) as Owner
      if (previous.identityId !== identity.identityId || previous.agentDirectory !== identity.agentDirectory)
        throw new Error('Identity is bound to another configuration directory')
      // An interrupted spawn may have created a child before its PID was recorded.
      // Unknown means occupied, even if the launcher died. Never infer exit from a timeout.
      if (previous.childPid === null || alive(previous.launcherPid) || alive(previous.childPid))
        throw new Error(
          `Identity already occupied: PID ${previous.childPid ?? previous.launcherPid}, ${previous.cwd}; no second Pi was started`
        )
    }
    writeAtomic(paths.owner, owner)
  })
  const change = (fn: () => void) =>
    guarded(() => {
      const current = JSON.parse(readFileSync(paths.owner, 'utf8')) as Owner
      if (current.nonce !== owner.nonce) throw new Error('Identity ownership changed')
      fn()
    })
  return {
    env: { [ENV]: JSON.stringify({ path: paths.owner, nonce: owner.nonce }) },
    commit(pid: number) {
      change(() => {
        owner.childPid = pid
        writeAtomic(paths.owner, owner)
      })
    },
    // Called only after observed child exit, or a confirmed spawn failure.
    release() {
      change(() => unlinkSync(paths.owner))
    }
  }
}

/** The environment is just a pointer; only the recorded OS child can adopt it. */
export function processIdentity(): NamedIdentity | null {
  const globals = globalThis as Record<symbol, unknown>
  if (globals[bindingKey] !== undefined) return globals[bindingKey] as NamedIdentity | null
  const raw = process.env[ENV]
  delete process.env[ENV]
  let identity: NamedIdentity | null = null
  if (raw) {
    const pointer = JSON.parse(raw) as { path: string; nonce: string }
    const owner = JSON.parse(readFileSync(pointer.path, 'utf8')) as Owner
    if (owner.nonce === pointer.nonce && owner.childPid === process.pid) identity = parseIdentity(owner)
  }
  globals[bindingKey] = identity
  return identity
}
export function rememberIdentitySession(identity: NamedIdentity, sessionFile: string | null, runtimeId: string) {
  writeAtomic(files(identity).cursor, { ...identity, sessionFile, runtimeId } satisfies Cursor)
}

const SESSION_HEADER_SCAN = 1024 * 1024

function firstJsonlRecordIsSessionHeader(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const value = JSON.parse(trimmed) as { type?: unknown; id?: unknown }
      return value.type === 'session' && typeof value.id === 'string'
    } catch {
      // Pi skips unparseable JSONL lines and then requires the first object to be the session header.
    }
  }
  return false
}

/** True when Pi would load this path instead of throwing "Session file is not a valid pi session". */
export function usablePiSessionFile(path: string): boolean {
  let size: number
  try {
    const st = statSync(path)
    if (!st.isFile()) return false
    size = st.size
  } catch {
    return false
  }
  if (size === 0) return true
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(Math.min(SESSION_HEADER_SCAN, size))
    const n = readSync(fd, buf, 0, buf.length, 0)
    return firstJsonlRecordIsSessionHeader(buf.subarray(0, n).toString('utf8'))
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function takeUsableSessionFile(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined
  if (usablePiSessionFile(path)) return path
  console.error(`pi-acp: ignoring invalid Pi session file, starting a new session: ${path}`)
  return undefined
}

function recordedIdentitySessionPath(identity: NamedIdentity): string | undefined {
  const path = files(identity).cursor
  if (!existsSync(path)) return undefined
  const cursor = JSON.parse(readFileSync(path, 'utf8')) as Cursor
  if (cursor.identityId !== identity.identityId || cursor.agentDirectory !== identity.agentDirectory)
    throw new Error('Identity session directory mismatch')
  return cursor.sessionFile && existsSync(cursor.sessionFile) ? cursor.sessionFile : undefined
}

export function identitySession(identity: NamedIdentity): string | undefined {
  return takeUsableSessionFile(recordedIdentitySessionPath(identity))
}

/** Cursor first, then the client fallback. Invalid files are skipped so a new session can start. */
export function resolveIdentitySessionFile(identity: NamedIdentity, fallback?: string): string | undefined {
  const recorded = recordedIdentitySessionPath(identity)
  const usable = takeUsableSessionFile(recorded)
  if (usable) return usable
  if (!fallback || fallback === recorded) return undefined
  return takeUsableSessionFile(fallback)
}
/** Shared by TUI and RPC. The lock belongs to the complete child lifetime, not ACP attachment. */
export function spawnNamedPi(
  command: string,
  args: string[],
  cwd: string,
  options: SpawnOptions,
  identity?: NamedIdentity
): ChildProcess {
  const invocation = buildPiInvocation(command, args, { cwd })
  if (!invocation) throw new Error(`Pi executable not found: ${command}`)
  const lease = identity ? claimIdentity(identity, cwd) : undefined
  const env = { ...process.env, ...options.env }
  delete env[ENV]
  if (identity) {
    env.PI_CODING_AGENT_DIR = identity.agentDirectory
    env.PI_CODING_AGENT_SESSION_DIR = join(identity.agentDirectory, 'sessions')
    Object.assign(env, lease!.env)
  }
  let child: ChildProcess
  try {
    child = spawn(invocation.executable, invocation.args, {
      ...options,
      cwd,
      env,
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    })
  } catch (error) {
    lease?.release()
    throw error
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    try {
      lease?.release()
    } catch (error) {
      console.error(`pi-acp: ${String(error)}`)
    }
  }
  child.once('exit', release)
  child.once('error', () => {
    if (child.pid === undefined) release()
  })
  if (child.pid && lease) {
    try {
      lease.commit(child.pid)
    } catch (error) {
      child.kill('SIGKILL')
      throw error
    }
  }
  return child
}

export async function runNamedTui(value: NamedIdentity & { cwd: string; sessionFile?: string }): Promise<number> {
  const identity = parseIdentity(value)
  const sessionFile = resolveIdentitySessionFile(identity, value.sessionFile)
  const args = ['--session-dir', join(identity.agentDirectory, 'sessions')]
  if (sessionFile) args.push('--session', sessionFile)
  const child = spawnNamedPi(
    getPiCommand(process.env.PI_ACP_PI_COMMAND),
    args,
    value.cwd,
    { stdio: 'inherit', env: { ...process.env, PI_MCP_TOOL_EXPOSURE: 'proxy-only' } },
    identity
  )
  const forward = (signal: NodeJS.Signals) => {
    child.kill(signal)
  }
  const term = () => forward('SIGTERM')
  process.on('SIGTERM', term)
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => resolve(code ?? 1))
    })
  } finally {
    process.off('SIGTERM', term)
  }
}
