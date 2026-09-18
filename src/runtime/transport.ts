import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { connect, type Socket } from 'node:net'
import { Duplex } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION, type ClientConnection } from '@agentclientprotocol/sdk'
import { getPiAcpDir } from '../acp/paths.js'
import { MAX_MCP_REQUEST_BYTES } from '../pi-rpc/mcp-servers.js'

export const RUNTIME_CAPABILITY = 'pi-acp/runtime/v1'
export const runtimeMethods = {
  list: '_pi/runtime/list',
  attach: '_pi/runtime/attach',
  status: '_pi/runtime/status',
  events: '_pi/runtime/events',
  deliver: '_pi/runtime/deliver',
  mcp: '_pi/runtime/mcp',
  detach: '_pi/runtime/detach'
} as const
export type RuntimeRecord = {
  runtimeId: string
  generation: string
  sessionId: string
  pid: number
  ownerPid: number | null
  identityId?: string | null
  cwd: string
  mode: 'tui' | 'rpc'
  endpoint: string
  token: string
}
export type RuntimeStatus = Omit<RuntimeRecord, 'endpoint' | 'token'> & {
  sessionFile: string | null
  busy: boolean
  model: string
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}
export function string(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new Error('Invalid string')
  return value
}
export function uuid(value: unknown): string {
  const id = string(value, 36)
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid identity')
  return id
}
export function runtimeDirectory(): string {
  const dir = join(getPiAcpDir(), 'runtimes')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error('Unsafe runtime directory')
  if (process.platform !== 'win32') chmodSync(dir, 0o700)
  return dir
}
export function recordPath(id: string): string {
  return join(runtimeDirectory(), `${uuid(id)}.json`)
}
export function readRuntime(id: string): RuntimeRecord {
  const path = recordPath(id),
    stat = lstatSync(path)
  if (!stat.isFile() || stat.size > 16384 || (process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077)))
    throw new Error('Unsafe runtime record')
  const r = object(JSON.parse(readFileSync(path, 'utf8')))
  if (
    uuid(r.runtimeId) !== id ||
    !Number.isSafeInteger(r.pid) ||
    Number(r.pid) <= 0 ||
    !['rpc', 'tui'].includes(String(r.mode))
  )
    throw new Error('Invalid runtime record')
  uuid(r.generation)
  uuid(r.sessionId)
  if (r.identityId !== undefined && r.identityId !== null) uuid(r.identityId)
  string(r.cwd)
  string(r.endpoint)
  string(r.token, 128)
  if (r.ownerPid !== null && (!Number.isSafeInteger(r.ownerPid) || Number(r.ownerPid) <= 0))
    throw new Error('Invalid runtime owner')
  const expected = socketEndpoint(id)
  if (r.endpoint !== expected) throw new Error('Unexpected runtime endpoint')
  return r as RuntimeRecord
}
export function discoverRuntimes(): Omit<RuntimeRecord, 'endpoint' | 'token'>[] {
  return readdirSync(runtimeDirectory())
    .filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
    .slice(0, 256)
    .flatMap(name => {
      try {
        const r = readRuntime(name.slice(0, -5))
        process.kill(r.pid, 0)
        if (r.mode === 'rpc' && r.ownerPid !== process.pid) return []
        const { endpoint: _endpoint, token: _token, ...publicRecord } = r
        return [publicRecord]
      } catch {
        return []
      }
    })
}
export function socketEndpoint(id: string): string {
  uuid(id)
  if (process.platform === 'win32') return `\\\\.\\pipe\\pi-acp-${id}`
  // Keep Unix socket paths short even when the configured registry directory is deep.
  const dir = `/tmp/pi-acp-${process.getuid!()}`
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.uid !== process.getuid!()) throw new Error('Unsafe socket directory')
  chmodSync(dir, 0o700)
  return join(dir, `${id}.sock`)
}
export function socketStream(socket: Socket) {
  // Bound individual records before feeding the SDK JSON decoder.
  let bytes = 0
  socket.on('data', (chunk: Buffer) => {
    let start = 0,
      end: number
    while ((end = chunk.indexOf(10, start)) >= 0) {
      if (bytes + end - start > MAX_MCP_REQUEST_BYTES + 16384) {
        socket.destroy(new Error('Runtime record too large'))
        return
      }
      bytes = 0
      start = end + 1
    }
    bytes += chunk.length - start
    if (bytes > MAX_MCP_REQUEST_BYTES + 16384) socket.destroy(new Error('Runtime record too large'))
  })
  const streams = Duplex.toWeb(socket)
  return ndJsonStream(streams.writable, streams.readable)
}
export async function runtimeRequest<T>(connection: ClientConnection, method: string, params: unknown): Promise<T> {
  const deadline = setTimeout(() => connection.close(new Error('Runtime request timed out')), 10000).unref()
  try {
    return await connection.agent.request<T>(method, params)
  } finally {
    clearTimeout(deadline)
  }
}
export class RuntimeClient {
  readonly connection: ClientConnection
  private constructor(
    readonly record: RuntimeRecord,
    readonly socket: Socket
  ) {
    this.connection = client({ name: 'pi-acp-runtime-client' }).connect(socketStream(socket))
    void this.connection.closed.catch(() => undefined)
  }
  static async open(id: string): Promise<RuntimeClient> {
    const record = readRuntime(id)
    if (record.mode === 'rpc' && record.ownerPid !== process.pid)
      throw new Error('Runtime belongs to another ACP process')
    const socket = connect(record.endpoint)
    socket.on('error', () => undefined)
    const peer = new RuntimeClient(record, socket)
    try {
      await runtimeRequest(peer.connection, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        _meta: { token: record.token }
      })
      return peer
    } catch (error) {
      peer.close()
      throw error
    }
  }
  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return runtimeRequest(this.connection, method, {
      ...params,
      runtimeId: this.record.runtimeId,
      generation: this.record.generation
    })
  }
  close() {
    this.connection.close()
    this.socket.destroy()
  }
}
export const newRuntimeIdentity = () => randomUUID()
