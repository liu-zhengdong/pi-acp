import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { agent, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { registerMcpBridge, type McpContext, type McpExtensionApi } from '../pi-rpc/mcp-extension.js'
import { processIdentity, rememberIdentitySession } from './identity.js'
import {
  object,
  recordPath,
  socketEndpoint,
  runtimeMethods,
  RUNTIME_CAPABILITY,
  socketStream,
  string,
  uuid,
  type RuntimeRecord,
  type RuntimeStatus
} from './transport.js'

type Context = McpContext & {
  cwd: string
  hasUI: boolean
  model?: { provider: string; id: string }
  sessionManager: {
    getSessionId(): string
    getSessionFile(): string | undefined
    getBranch?(): Array<{ type: string; customType?: string }>
  }
}
type SendMessage = (
  message: { customType: string; content: string; display: boolean; details?: Record<string, unknown> },
  options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' }
) => void
const identityKey = Symbol.for('@liuser/pi-acp/runtime-identity/v1')

/** One process-local entry, shared by the standalone package and managed RPC extension. */
export function registerRuntimeBridge(pi: McpExtensionApi, mcp: ReturnType<typeof registerMcpBridge>): void {
  const send = (pi as McpExtensionApi & { sendMessage?: SendMessage }).sendMessage?.bind(pi)
  if (!send) return // Older/test hosts without this public Pi API do not advertise live control.
  const named = processIdentity()
  const globals = globalThis as Record<symbol, unknown>
  const runtimeId = typeof globals[identityKey] === 'string' ? (globals[identityKey] as string) : randomUUID()
  globals[identityKey] = runtimeId
  let ctx: Context | undefined, record: RuntimeRecord | undefined, server: Server | undefined
  let epoch = 0,
    closing = true,
    owner: symbol | undefined
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  const sockets = new Set<Socket>()
  const received = new Map<string, string>()
  const registrations = new Set<(ctx: McpContext) => Promise<void>>()
  function current(generation: number): Context {
    // Pi context getters can refer to a disposed session after /new or /reload.
    if (closing || generation !== epoch || !ctx) throw new Error('Runtime generation is no longer active')
    return ctx
  }
  function status(generation: number): RuntimeStatus {
    const context = current(generation)
    if (!record) throw new Error('Runtime is not ready')
    const { token: _token, endpoint: _endpoint, ...identity } = record
    return {
      ...identity,
      sessionId: context.sessionManager.getSessionId(),
      sessionFile: context.sessionManager.getSessionFile() ?? null,
      cwd: context.cwd,
      busy: !context.isIdle() || context.hasPendingMessages(),
      model: context.model ? `${context.model.provider}/${context.model.id}` : ''
    }
  }
  async function release(lease: symbol, generation: number) {
    if (closing || generation !== epoch || owner !== lease) return
    const context = current(generation)
    if (!context.isIdle() || context.hasPendingMessages()) {
      cleanupTimer = setTimeout(() => void release(lease, generation), 250).unref()
      return
    }
    try {
      for (const dispose of registrations) {
        await dispose(context)
        registrations.delete(dispose)
      }
    } catch {
      // Retain the lease while a registration cannot safely be removed.
      cleanupTimer = setTimeout(() => void release(lease, generation), 1000).unref()
      return
    }
    if (!closing && generation === epoch && owner === lease) owner = undefined
  }
  async function stop() {
    closing = true
    epoch++
    clearTimeout(cleanupTimer)
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    owner = undefined
    received.clear()
    registrations.clear()
    const previous = server,
      previousRecord = record
    server = undefined
    record = undefined
    ctx = undefined
    if (previous) await new Promise<void>(resolve => previous.close(() => resolve()))
    if (previousRecord) {
      try {
        unlinkSync(recordPath(previousRecord.runtimeId))
      } catch {
        /* already removed */
      }
      if (process.platform !== 'win32')
        try {
          unlinkSync(previousRecord.endpoint)
        } catch {
          /* net removed it */
        }
    }
  }
  pi.on('session_start', async (_, context) => {
    await stop()
    ctx = context as Context
    closing = false
    const generation = epoch
    const mode = process.argv.some(
      (arg, i) => arg === '--mode=rpc' || (arg === '--mode' && process.argv[i + 1] === 'rpc')
    )
      ? 'rpc'
      : 'tui'
    const endpoint = socketEndpoint(runtimeId)
    record = {
      runtimeId,
      generation: randomUUID(),
      sessionId: ctx.sessionManager.getSessionId(),
      pid: process.pid,
      ownerPid: mode === 'rpc' ? process.ppid : null,
      identityId: named?.identityId ?? null,
      cwd: ctx.cwd,
      mode,
      endpoint,
      token: randomBytes(32).toString('hex')
    }
    server = createServer(socket => {
      if (sockets.size >= 64) {
        socket.destroy()
        return
      }
      sockets.add(socket)
      socket.setTimeout(10000, () => socket.destroy())
      socket.on('error', () => undefined)
      socket.once('close', () => sockets.delete(socket))
      const lease = Symbol('runtime-client')
      let initialized = false
      const ready = (value: unknown) => {
        if (!initialized || owner !== lease) throw new Error('Initialize and acquire the runtime first')
        const params = object(value),
          now = status(generation)
        if (params.runtimeId !== now.runtimeId || params.generation !== now.generation)
          throw new Error('Runtime generation mismatch')
        return { params, now }
      }
      const connection = agent({ name: 'pi-acp-runtime' })
        .onRequest('initialize', ({ params }) => {
          current(generation)
          if (initialized || owner) throw new Error('Runtime already has a controller')
          const token = object(params._meta).token
          if (
            typeof token !== 'string' ||
            !/^[a-f0-9]{64}$/.test(token) ||
            !timingSafeEqual(Buffer.from(token), Buffer.from(record!.token))
          )
            throw new Error('Invalid runtime credential')
          initialized = true
          socket.setTimeout(0)
          owner = lease
          return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, _meta: { [RUNTIME_CAPABILITY]: true } }
        })
        .onRequest(runtimeMethods.status, object, ({ params }) => ready(params).now)
        .onRequest(runtimeMethods.deliver, object, ({ params }) => {
          const { now } = ready(params)
          if (params.sessionId !== now.sessionId) throw new Error('Session changed; reconfirm the target')
          const id = uuid(params.id),
            text = string(params.text, 30000),
            source = string(params.source, 160)
          if (/[\p{Cc}\p{Cf}]/u.test(source)) throw new Error('Invalid message source')
          if (!['steer', 'followUp'].includes(String(params.delivery))) throw new Error('Invalid delivery mode')
          if (params.triggerTurn !== undefined && typeof params.triggerTurn !== 'boolean')
            throw new Error('Invalid triggerTurn')
          const fingerprint = createHash('sha256')
            .update(JSON.stringify([now.sessionId, text, source, params.delivery, params.triggerTurn ?? true]))
            .digest('hex')
          const previous = received.get(id)
          if (previous && previous !== fingerprint) throw new Error('Delivery id reused with different content')
          if (previous) return { accepted: true, duplicate: true, sessionId: now.sessionId }
          send(
            {
              customType: 'pi-acp-external',
              content: `来自 ${source}\n\n${text}`,
              display: true,
              details: { deliveryId: id, source }
            },
            {
              // Pi defers triggerTurn:false messages until agent_end, even with deliverAs:'steer'.
              // Suppress idle wakes, not insertion into the already-running conversation.
              triggerTurn: !current(generation).isIdle() || params.triggerTurn !== false,
              deliverAs: params.delivery as 'steer' | 'followUp'
            }
          )
          received.set(id, fingerprint)
          if (received.size > 2000) received.delete(received.keys().next().value!)
          return { accepted: true, sessionId: now.sessionId }
        })
        .onRequest(runtimeMethods.mcp, object, async ({ params }) => {
          const { now } = ready(params)
          if (params.sessionId !== now.sessionId) throw new Error('Session changed; reconfirm the target')
          const dispose = await mcp.add(params.mcpServers, current(generation))
          if (dispose) registrations.add(dispose)
          const notice = mcp.notice(current(generation))
          if (notice) send(notice.message, { deliverAs: 'steer', triggerTurn: !current(generation).isIdle() })
          return { registered: true }
        })
        .connect(socketStream(socket))
      void connection.closed.catch(() => undefined).then(() => release(lease, generation))
      socket.once('close', () => connection.close())
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(endpoint, () => {
        server!.off('error', reject)
        resolve()
      })
    })
    server.on('error', () => void stop())
    if (process.platform !== 'win32') chmodSync(endpoint, 0o600)
    const path = recordPath(runtimeId),
      temp = `${path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 })
    renameSync(temp, path)
    if (named) rememberIdentitySession(named, ctx.sessionManager.getSessionFile() ?? null, runtimeId)
  })
  pi.on('before_agent_start', (_, context) => {
    if (!closing) ctx = context as Context
  })
  pi.on('session_shutdown', () => stop())
}

export default function runtimeExtension(pi: McpExtensionApi): void {
  // Managed RPC already loads acp-extension explicitly; avoid double registration when globally installed.
  if (process.argv.some((arg, i) => arg === '--mode=rpc' || (arg === '--mode' && process.argv[i + 1] === 'rpc'))) return
  registerRuntimeBridge(pi, registerMcpBridge(pi))
}
