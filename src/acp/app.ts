import { EVENTS_CAPABILITY } from '../runtime/events.js'
import {
  agent as acpAgent,
  methods,
  RequestError,
  type AgentApp,
  type NewSessionRequest,
  type LoadSessionRequest
} from '@agentclientprotocol/sdk'
import { McpConfigurationError, parseMcpServers } from '../pi-rpc/mcp-servers.js'
import { PiAcpAgent, runPromptWithCancellation } from './agent.js'
import { ClientConnection } from './client.js'
import { RuntimeGateway } from '../runtime/gateway.js'
import { IDENTITY_CAPABILITY } from '../runtime/identity.js'
import { object, string, RUNTIME_CAPABILITY, runtimeMethods } from '../runtime/transport.js'
import { SessionRepository } from './session-repository.js'

// SDK 1.4 的默认解析器会丢弃无效 MCP 项；在原始请求边界校验，避免成功返回缺少能力的会话。
function newSessionParams(value: unknown): NewSessionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw RequestError.invalidParams()
  const request = value as Record<string, unknown>
  if (typeof request.cwd !== 'string') throw RequestError.invalidParams({}, 'cwd 必须是字符串')
  if (
    request.additionalDirectories !== undefined &&
    (!Array.isArray(request.additionalDirectories) ||
      request.additionalDirectories.some(path => typeof path !== 'string'))
  )
    throw RequestError.invalidParams({}, 'additionalDirectories 必须是字符串数组')
  if (
    request._meta !== undefined &&
    (typeof request._meta !== 'object' || request._meta === null || Array.isArray(request._meta))
  )
    throw RequestError.invalidParams({}, '_meta 必须是对象')
  try {
    return { ...request, cwd: request.cwd, mcpServers: parseMcpServers(request.mcpServers) }
  } catch (error) {
    if (error instanceof McpConfigurationError) throw RequestError.invalidParams({ reason: error.code }, error.message)
    throw error
  }
}

function existingSessionParams(value: unknown): LoadSessionRequest {
  const request = newSessionParams(value)
  const sessionId = (value as Record<string, unknown>).sessionId
  if (typeof sessionId !== 'string' || !sessionId) throw RequestError.invalidParams({}, 'sessionId 必须是非空字符串')
  return { ...request, sessionId }
}

/**
 * Builds the ACP agent app with exactly the methods this adapter implements
 * and advertises (see `PiAcpAgent.initialize`). The `PiAcpAgent` instance is
 * created per connection in `onConnect` because it needs the
 * connection-scoped client peer handle.
 */
export function createPiAcpAgentApp(opts?: { onAgent?: (agent: PiAcpAgent | null) => void }): AgentApp {
  let active: PiAcpAgent | null = null
  let runtimes: RuntimeGateway | null = null
  // ACP wire state is connection-scoped. `initializing` closes the race where
  // two concurrent initialize requests both observed a false boolean.
  let initializeState: 'uninitialized' | 'initializing' | 'initialized' = 'uninitialized'

  const getAgent = (): PiAcpAgent => {
    if (!active) throw RequestError.internalError({}, 'pi-acp agent is not connected')
    return active
  }

  const getInitializedAgent = (): PiAcpAgent => {
    const agent = getAgent()
    if (initializeState !== 'initialized') {
      throw RequestError.invalidRequest({}, 'Agent is not initialized: call initialize first')
    }
    return agent
  }

  return acpAgent({ name: 'pi-acp' })
    .onConnect(connection => {
      const gateway = new RuntimeGateway()
      const agent = new PiAcpAgent(new ClientConnection(connection.client), gateway)
      runtimes = gateway
      active = agent
      initializeState = 'uninitialized'
      opts?.onAgent?.(agent)

      connection.signal.addEventListener(
        'abort',
        () => {
          if (active === agent) {
            active = null
            initializeState = 'uninitialized'
            opts?.onAgent?.(null)
          }
          gateway.close()
          agent.dispose()
        },
        { once: true }
      )
    })
    .onRequest(methods.agent.initialize, async ctx => {
      if (initializeState !== 'uninitialized') {
        throw RequestError.invalidRequest({}, 'Agent is already initializing or initialized')
      }

      const agent = getAgent()
      initializeState = 'initializing'
      try {
        const response = await agent.initialize(ctx.params)
        if (active !== agent) {
          throw RequestError.requestCancelled({}, 'ACP connection closed during initialize')
        }
        initializeState = 'initialized'
        return {
          ...response,
          _meta: {
            ...response._meta,
            [RUNTIME_CAPABILITY]: true,
            [EVENTS_CAPABILITY]: true,
            [IDENTITY_CAPABILITY]: true
          }
        }
      } catch (error) {
        // Do not reset state belonging to a newer connection.
        if (active === agent) initializeState = 'uninitialized'
        throw error
      }
    })
    .onRequest('_pi/session/import', object, ctx => {
      getInitializedAgent()
      return new SessionRepository().importFile(string(ctx.params.cwd), string(ctx.params.sessionFile))
    })
    .onRequest('_pi/identity/stop', object, ctx => {
      getInitializedAgent()
      return runtimes!.stop(ctx.params)
    })
    .onRequest('_pi/identity/start', object, ctx => {
      getInitializedAgent()
      return runtimes!.start(ctx.params)
    })
    .onRequest(runtimeMethods.list, object, () => {
      getInitializedAgent()
      return runtimes!.list()
    })
    .onRequest(runtimeMethods.attach, object, ctx => {
      getInitializedAgent()
      return runtimes!.attach(ctx.params)
    })
    .onRequest(runtimeMethods.status, object, ctx => {
      getInitializedAgent()
      return runtimes!.request(runtimeMethods.status, ctx.params)
    })
    .onRequest(runtimeMethods.events, object, ctx => {
      getInitializedAgent()
      return runtimes!.request(runtimeMethods.events, ctx.params)
    })
    .onRequest(runtimeMethods.deliver, object, ctx => {
      getInitializedAgent()
      return runtimes!.request(runtimeMethods.deliver, ctx.params)
    })
    .onRequest(runtimeMethods.mcp, object, ctx => {
      getInitializedAgent()
      return runtimes!.request(runtimeMethods.mcp, ctx.params)
    })
    .onRequest(runtimeMethods.detach, object, ctx => {
      getInitializedAgent()
      return runtimes!.request(runtimeMethods.detach, ctx.params)
    })
    .onRequest(methods.agent.authenticate, ctx => getInitializedAgent().authenticate(ctx.params))
    .onRequest(methods.agent.session.new, newSessionParams, ctx => getInitializedAgent().newSession(ctx.params))
    .onRequest(methods.agent.session.load, existingSessionParams, ctx => getInitializedAgent().loadSession(ctx.params))
    .onRequest(methods.agent.session.list, ctx => getInitializedAgent().listSessions(ctx.params))
    .onRequest(methods.agent.session.resume, existingSessionParams, ctx =>
      getInitializedAgent().resumeSession(ctx.params)
    )
    .onRequest(methods.agent.session.close, ctx => getInitializedAgent().closeSession(ctx.params))
    .onRequest(methods.agent.session.delete, ctx => getInitializedAgent().deleteSession(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, ctx => getInitializedAgent().setSessionConfigOption(ctx.params))
    .onRequest(methods.agent.session.prompt, ctx =>
      runPromptWithCancellation(getInitializedAgent(), ctx.params, ctx.signal)
    )
    .onNotification(methods.agent.session.cancel, ctx => getInitializedAgent().cancel(ctx.params))
}
