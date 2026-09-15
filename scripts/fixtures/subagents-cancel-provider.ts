// Product-test provider only: real Pi + unmodified pi-subagents, no network.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export default function (pi: import('@earendil-works/pi-coding-agent').ExtensionAPI) {
  const root = process.env.PI_ACP_STOCK_ROOT
  if (!root) throw new Error('PI_ACP_STOCK_ROOT is required')
  const log = (data: Record<string, unknown>) =>
    appendFileSync(join(root, 'stock.jsonl'), JSON.stringify({ at: Date.now(), pid: process.pid, ...data }) + '\n')
  const key = Symbol.for('@agegr/pi-web/session-liveness/v1')
  type Provider = { name: string; sessionId: string; isActive(): boolean }
  type Registry = { version: number; register(provider: Provider): () => void }
  const globals = globalThis as Record<symbol, Registry | undefined>
  const previous = globals[key]
  const providers = new Set<Provider>()
  const registry: Registry = {
    version: 1,
    register(provider) {
      providers.add(provider)
      const release = previous?.register(provider)
      return () => {
        providers.delete(provider)
        release?.()
      }
    }
  }
  globals[key] = registry
  let sessionId = ''
  let timer: ReturnType<typeof setInterval> | undefined
  pi.events.on('subagents:rpc:v1:request', raw => {
    const request = raw as { method: string; requestId: string; params?: unknown }
    if (request.method !== 'stop' && request.method !== 'interrupt' && !(request.method === 'status' && request.params))
      return
    const unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${request.requestId}`, reply => {
      unsubscribe()
      log({ event: `${request.method}-reply`, sessionId, request, reply })
    })
  })
  pi.on('session_start', (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId()
    log({ event: 'session', sessionId, file: ctx.sessionManager.getSessionFile() })
    // Observe only this test session through the public host RPC/registry.
    timer = setInterval(() => {
      const requestId = crypto.randomUUID()
      const replyEvent = `subagents:rpc:v1:reply:${requestId}`
      const unsubscribe = pi.events.on(replyEvent, raw => {
        unsubscribe()
        const reply = raw as { success?: boolean; data?: { asyncSnapshot?: unknown } }
        const value = {
          event: 'snapshot',
          sessionId,
          live: [...providers]
            .filter(p => p.name === 'pi-subagents' && p.sessionId === sessionId)
            .some(p => p.isActive()),
          idle: ctx.isIdle(),
          pending: ctx.hasPendingMessages(),
          reply
        }
        log(value)
      })
      pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method: 'status' })
    }, 25)
  })
  pi.on('tool_result', (event, ctx) => {
    if (event.toolName === 'subagent')
      log({
        event: 'tool_result',
        sessionId: ctx.sessionManager.getSessionId(),
        details: event.details,
        content: event.content,
        isError: event.isError
      })
  })
  pi.on('message_start', event => {
    if (event.message.role === 'custom') log({ event: 'custom', message: event.message })
  })
  pi.registerProvider('stock-eval', {
    baseUrl: 'http://unused.invalid',
    apiKey: 'no-network',
    api: 'stock-eval',
    models: [
      {
        id: 'local',
        name: 'Deterministic local',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 1000
      }
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream()
      const last = context.messages.at(-1)
      const text = last?.role === 'user' ? JSON.stringify(last.content) : ''
      const nested = text.includes('STOCK_NESTED_ROOT')
      const launch = text.includes('STOCK_LAUNCH') || nested
      const gate = text.includes('STOCK_GATE_LEAF')
      const content = launch
        ? [
            {
              type: 'toolCall',
              id: crypto.randomUUID(),
              name: 'subagent',
              arguments: {
                agent: text.includes('STOCK_LAUNCH_NESTED') ? 'eval-root' : 'eval-leaf',
                task: text.includes('STOCK_LAUNCH_NESTED')
                  ? 'STOCK_NESTED_ROOT'
                  : nested
                    ? 'STOCK_GATE_LEAF'
                    : 'STOCK_QUICK_LEAF',
                async: true,
                context: 'fresh',
                mission: false
              }
            }
          ]
        : [{ type: 'text', text: 'STOCK_RESPONSE' }]
      const message = {
        role: 'assistant',
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: launch ? 'toolUse' : 'stop',
        timestamp: Date.now()
      }
      if (gate) log({ event: 'leaf-live', sessionId })
      const finish = () => {
        const aborted = options?.signal?.aborted
        if (gate)
          log({ event: 'leaf-settled', sessionId, aborted, gateReleased: existsSync(join(root, 'release-leaf')) })
        stream.push({ type: 'start', partial: message })
        if (aborted) stream.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted' } })
        else {
          if (launch) stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: content[0], partial: message })
          else stream.push({ type: 'text_delta', contentIndex: 0, delta: 'STOCK_RESPONSE', partial: message })
          stream.push({ type: 'done', reason: message.stopReason, message })
        }
        stream.end()
      }
      if (gate) {
        const started = Date.now()
        const gateTimer = setInterval(() => {
          if (!options?.signal?.aborted && !existsSync(join(root, 'release-leaf')) && Date.now() - started < 15000)
            return
          clearInterval(gateTimer)
          finish()
        }, 10)
      } else setTimeout(finish, 10)
      return stream
    }
  })
  pi.on('session_shutdown', () => {
    clearInterval(timer)
    log({ event: 'session-shutdown', sessionId })
    if (globals[key] === registry) {
      if (previous) globals[key] = previous
      else delete globals[key]
    }
  })
}
