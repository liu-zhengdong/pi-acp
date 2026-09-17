import {
  MAX_MCP_REQUEST_BYTES,
  MCP_COMMAND,
  MCP_REGISTER_EVENT,
  MCP_WIDGET,
  McpConfigurationError,
  mcpDefinition,
  parseMcpServers,
  type McpServer
} from './mcp-servers.js'

type Registration = { readonly toolExposure?: string; dispose(): Promise<void> }
type Owned = { server: McpServer; registration: Registration }
export type McpContext = {
  isIdle(): boolean
  hasPendingMessages(): boolean
  sessionManager?: { getBranch?(): Array<{ type: string; customType?: string }> }
  ui: { setWidget(key: string, lines: string[]): void }
}
export type McpExtensionApi = {
  events: { emit(name: string, data: unknown): void }
  on(name: string, handler: (event: unknown, ctx: McpContext) => unknown): void
  registerCommand(
    name: string,
    command: { description: string; handler(args: string, ctx: McpContext): Promise<void> }
  ): void
}

export function registerMcpBridge(pi: McpExtensionApi) {
  let generation = 0
  let owned = new Map<string, Owned>()
  let updating = false
  let closing = false
  let noticePending = false
  let checkedHistory = false
  let poisoned = false

  const register = async (server: McpServer): Promise<Owned> => {
    const request: {
      version: 1
      requiredToolExposure: 'proxy-only'
      name: string
      definition: Record<string, unknown>
      result?: { ok: boolean; registration?: Registration; error?: unknown }
    } = { version: 1, requiredToolExposure: 'proxy-only', name: server.name, definition: mcpDefinition(server) }
    try {
      pi.events.emit(MCP_REGISTER_EVENT, request)
    } catch {
      throw new McpConfigurationError('MCP_REGISTRATION_FAILED', `注册 MCP 服务 ${server.name} 失败`)
    }
    if (!request.result)
      throw new McpConfigurationError('MCP_ADAPTER_UNAVAILABLE', '需要安装支持运行时注册的 pi-mcp-adapter')
    if (!request.result.ok) {
      const error = request.result.error
      if (error instanceof Error && error.message === `MCP server "${server.name}" is already registered`)
        throw new McpConfigurationError('MCP_SERVER_CONFLICT', `MCP 服务名称冲突：${server.name}；原服务保持不变`)
      throw new McpConfigurationError('MCP_REGISTRATION_FAILED', `注册 MCP 服务 ${server.name} 失败；未返回服务凭据`)
    }
    if (typeof request.result.registration?.dispose !== 'function')
      throw new McpConfigurationError('MCP_ADAPTER_INCOMPATIBLE', 'pi-mcp-adapter 返回了不兼容的注册结果')
    if (request.result.registration.toolExposure !== 'proxy-only') {
      try {
        await request.result.registration.dispose()
      } catch {
        poisoned = true
        throw new McpConfigurationError('MCP_ROLLBACK_FAILED', '不兼容 MCP 注册释放失败，请重新加载会话')
      }
      throw new McpConfigurationError(
        'MCP_ADAPTER_INCOMPATIBLE',
        '需要支持 proxy-only 回执的 pi-mcp-adapter；请以固定代理模式重新启动 Pi'
      )
    }
    return { server, registration: request.result.registration }
  }

  const release = async (entries: Iterable<Owned>): Promise<boolean> => {
    const results = await Promise.allSettled([...entries].map(entry => entry.registration.dispose()))
    return results.every(result => result.status === 'fulfilled')
  }

  const updates = new Set<Promise<void>>()
  const configureCore = async (value: unknown, ctx: McpContext, appendWhileBusy: boolean) => {
    const servers = parseMcpServers(value)
    const epoch = generation
    if (closing || poisoned)
      throw new McpConfigurationError('MCP_BRIDGE_UNAVAILABLE', 'MCP 注册桥接不可用，请重新加载会话')
    if (
      updating ||
      ((!ctx.isIdle() || ctx.hasPendingMessages()) &&
        (!appendWhileBusy ||
          [...owned].some(
            ([name, entry]) =>
              !servers.some(server => server.name === name && JSON.stringify(server) === JSON.stringify(entry.server))
          )))
    )
      throw new McpConfigurationError('MCP_SESSION_BUSY', '会话忙碌，暂不能更新 MCP 服务')
    updating = true
    const previous = owned
    const next = new Map<string, Owned>()
    const added: Owned[] = []
    const removed: Owned[] = []
    try {
      for (const server of servers) {
        if (closing || epoch !== generation) throw new McpConfigurationError('MCP_BRIDGE_UNAVAILABLE', '会话正在关闭')
        const existing = previous.get(server.name)
        if (existing && JSON.stringify(existing.server) === JSON.stringify(server)) {
          next.set(server.name, existing)
          continue
        }
        if (existing) {
          removed.push(existing)
          await existing.registration.dispose()
        }
        const entry = await register(server)
        added.push(entry)
        next.set(server.name, entry)
      }
      for (const [name, entry] of previous) {
        if (next.has(name)) continue
        removed.push(entry)
        await entry.registration.dispose()
      }
      if (closing || epoch !== generation) throw new McpConfigurationError('MCP_BRIDGE_UNAVAILABLE', '会话正在关闭')
      owned = next
      noticePending = true
    } catch (error) {
      let restored = await release(added)
      if (!closing && epoch === generation) {
        for (const entry of removed) {
          try {
            previous.set(entry.server.name, await register(entry.server))
          } catch {
            restored = false
          }
        }
      }
      poisoned ||= !restored
      if (poisoned) throw new McpConfigurationError('MCP_ROLLBACK_FAILED', 'MCP 注册回滚失败，请重新加载会话')
      throw error
    } finally {
      if (epoch === generation) updating = false
    }
  }

  const configure = (value: unknown, ctx: McpContext, appendWhileBusy = false) => {
    const task = configureCore(value, ctx, appendWhileBusy)
    updates.add(task)
    void task.finally(() => updates.delete(task)).catch(() => undefined)
    return task
  }

  pi.registerCommand(MCP_COMMAND, {
    description: '内部 ACP MCP 注册桥接',
    async handler(args, ctx) {
      let id: string | undefined
      const reply = (success: boolean, code?: string, message?: string) =>
        ctx.ui.setWidget(MCP_WIDGET, [JSON.stringify({ version: 1, id, success, code, message })])
      try {
        if (args.length > Math.ceil(MAX_MCP_REQUEST_BYTES * 1.5) || !/^[A-Za-z0-9_-]+$/.test(args))
          throw new McpConfigurationError('INVALID_MCP_SERVERS', '无效的 MCP 注册请求')
        const request = JSON.parse(Buffer.from(args, 'base64url').toString('utf8')) as {
          version?: unknown
          id?: unknown
          servers?: unknown
        }
        if (request?.version !== 1 || typeof request.id !== 'string' || !/^[a-f0-9-]{36}$/.test(request.id))
          throw new McpConfigurationError('INVALID_MCP_SERVERS', '无效的 MCP 请求标识')
        id = request.id
        await configure(request.servers, ctx)
        reply(true)
      } catch (error) {
        const known = error instanceof McpConfigurationError
        reply(
          false,
          known ? error.code : 'MCP_REGISTRATION_FAILED',
          known ? error.message : 'MCP 注册失败；未返回服务凭据'
        )
      }
    }
  })

  const notice = (ctx: McpContext) => {
    if (!checkedHistory) {
      checkedHistory = true
      noticePending ||=
        ctx.sessionManager
          ?.getBranch?.()
          .some(entry => entry.type === 'custom_message' && entry.customType === 'pi-acp-mcp-tools') ?? false
    }
    if (!noticePending || closing || poisoned) return
    noticePending = false
    const names = [...owned.keys()]
    return {
      message: {
        customType: 'pi-acp-mcp-tools',
        display: false,
        content: names.length
          ? `本次 ACP 连接额外提供的 MCP 服务：${names.join('、')}。原有配置的服务保持可用。\n` +
            '使用固定 mcp 代理发现工具：mcp({server:"服务名称"})；查看参数：mcp({server:"服务名称",describe:"工具名称"})；' +
            '调用：mcp({server:"服务名称",tool:"工具名称",args:{...}})。具体工具描述和参数从返回结果读取。\n' +
            '这是能力使用说明，不要求立即调用工具，也不改变当前任务。'
          : '本次 ACP 连接未提供额外 MCP 服务；原有配置的服务保持可用。历史中的 ACP 服务提示不代表本次连接仍提供这些服务。'
      }
    }
  }
  pi.on('before_agent_start', (_event, ctx) => notice(ctx))
  pi.on('session_start', () => {
    generation++
    closing = false
    poisoned = false
    updating = false
    checkedHistory = false
    noticePending = false
  })
  pi.on('session_shutdown', async () => {
    generation++
    closing = true
    await Promise.allSettled([...updates])
    const current = owned
    owned = new Map()
    if (!(await release(current.values()))) console.error('pi-acp: MCP 注册释放失败')
  })
  return {
    configure,
    notice,
    async add(value: unknown, ctx: McpContext) {
      const before = new Set(owned.values())
      const servers = parseMcpServers(value)
      for (const server of servers) {
        const existing = owned.get(server.name)
        if (existing && JSON.stringify(existing.server) !== JSON.stringify(server))
          throw new McpConfigurationError('MCP_SERVER_CONFLICT', `MCP 服务名称冲突：${server.name}`)
      }
      await configure(
        [...owned.values()]
          .map(entry => entry.server)
          .filter(server => !servers.some(addition => addition.name === server.name))
          .concat(servers),
        ctx,
        true
      )
      const additions = new Set([...owned.values()].filter(entry => !before.has(entry)))
      if (!additions.size) return undefined
      return async (context: McpContext) => {
        await configure(
          [...owned.values()].filter(entry => !additions.has(entry)).map(entry => entry.server),
          context
        )
      }
    }
  }
}
