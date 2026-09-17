import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerMcpBridge, type McpExtensionApi } from '../../src/pi-rpc/mcp-extension.js'
import { MCP_COMMAND, MCP_REGISTER_EVENT, MCP_WIDGET } from '../../src/pi-rpc/mcp-servers.js'

type Command = Parameters<McpExtensionApi['registerCommand']>[1]
type Hook = Parameters<McpExtensionApi['on']>[1]
type Context = Parameters<Command['handler']>[1]
type Request = { name: string; definition: Record<string, unknown>; result?: unknown }
const service = (name: string, url = 'https://example.test/mcp') => ({
  name,
  type: 'http',
  url,
  headers: [{ name: 'Authorization', value: 'Bearer SECRET' }]
})

function harness(
  options: { missing?: boolean; incompatible?: boolean; legacy?: boolean; busy?: boolean; history?: boolean } = {}
) {
  const configured = { preserved: true }
  const active = new Map<string, unknown>([['configured', configured]])
  const commands = new Map<string, Command>()
  const hooks = new Map<string, Hook>()
  const replies: Array<{ success: boolean; code?: string; message?: string }> = []
  const registrations: Request[] = []
  const disposed: string[] = []
  const ctx: Context = {
    isIdle: () => !options.busy,
    hasPendingMessages: () => false,
    sessionManager: {
      getBranch: () => (options.history ? [{ type: 'custom_message', customType: 'pi-acp-mcp-tools' }] : [])
    },
    ui: {
      setWidget(key, lines) {
        assert.equal(key, MCP_WIDGET)
        replies.push(JSON.parse(lines[0]!))
      }
    }
  }
  registerMcpBridge({
    registerCommand: (name, command) => {
      commands.set(name, command)
    },
    on: (name, handler) => {
      hooks.set(name, handler)
    },
    events: {
      emit(name, raw) {
        assert.equal(name, MCP_REGISTER_EVENT)
        const request = raw as Request
        if (options.missing) return
        registrations.push(request)
        if (active.has(request.name)) {
          request.result = { ok: false, error: new Error(`MCP server "${request.name}" is already registered`) }
          return
        }
        if (options.incompatible) {
          request.result = { ok: true, registration: {} }
          return
        }
        active.set(request.name, request.definition)
        let released = false
        request.result = {
          ok: true,
          registration: {
            toolExposure: options.legacy ? undefined : 'proxy-only',
            async dispose() {
              if (released) return
              released = true
              disposed.push(request.name)
              active.delete(request.name)
            }
          }
        }
      }
    }
  })
  return {
    active,
    configured,
    registrations,
    disposed,
    replies,
    ctx,
    hooks,
    async configure(servers: unknown) {
      await commands
        .get(MCP_COMMAND)!
        .handler(Buffer.from(JSON.stringify({ version: 1, id: randomUUID(), servers })).toString('base64url'), ctx)
      return replies.at(-1)!
    },
    notice: () =>
      hooks.get('before_agent_start')!({}, ctx) as { message?: { content: string }; systemPrompt?: string } | undefined
  }
}

test('注册增量服务并使用代理；说明只追加一次且不含凭据、不重写 system prompt', async () => {
  const h = harness()
  assert.equal((await h.configure([service('chat')])).success, true)
  assert.equal(h.active.get('configured'), h.configured)
  assert.deepEqual(h.registrations[0]!.definition, {
    url: 'https://example.test/mcp',
    headers: { Authorization: 'Bearer SECRET' },
    httpTransport: 'streamable-http',
    directTools: false
  })
  const notice = h.notice()!
  assert.match(notice.message!.content, /chat/)
  assert.match(notice.message!.content, /describe/)
  assert.doesNotMatch(notice.message!.content, /SECRET|Authorization|example\.test/)
  assert.equal(notice.systemPrompt, undefined)
  assert.equal(h.notice(), undefined)
  assert.equal((await h.configure([service('chat')])).success, true)
  assert.equal(h.registrations.length, 1, '相同定义复用已有注册')
  await h.hooks.get('session_shutdown')!({}, h.ctx)
  assert.deepEqual([...h.active.keys()], ['configured'])
  assert.deepEqual(h.disposed, ['chat'])
})

test('中途名称冲突回滚本次新增，保留原配置', async () => {
  const h = harness()
  const result = await h.configure([service('new'), service('configured')])
  assert.equal(result.success, false)
  assert.equal(result.code, 'MCP_SERVER_CONFLICT')
  assert.deepEqual([...h.active.keys()], ['configured'])
  assert.equal(h.active.get('configured'), h.configured)
  assert.equal(h.notice(), undefined)
})

test('更新同名已持有服务后失败，恢复旧定义和其他已持有服务', async () => {
  const h = harness()
  await h.configure([service('chat')])
  const old = h.active.get('chat')
  h.notice()
  const result = await h.configure([service('chat', 'https://changed.test/mcp'), service('configured')])
  assert.equal(result.success, false)
  assert.deepEqual(h.active.get('chat'), old)
  assert.equal(h.active.get('configured'), h.configured)
  assert.equal(h.notice(), undefined)
})

test('替换和清空仅影响当前桥接持有的服务', async () => {
  const h = harness()
  await h.configure([service('chat'), service('old')])
  assert.equal((await h.configure([service('chat', 'https://changed.test/mcp'), service('new')])).success, true)
  assert.deepEqual([...h.active.keys()].sort(), ['chat', 'configured', 'new'])
  assert.equal((await h.configure([])).success, true)
  assert.deepEqual([...h.active.keys()], ['configured'])
  assert.match(h.notice()!.message!.content, /未提供额外 MCP/)
})

for (const [options, code] of [
  [{ missing: true }, 'MCP_ADAPTER_UNAVAILABLE'],
  [{ incompatible: true }, 'MCP_ADAPTER_INCOMPATIBLE'],
  [{ legacy: true }, 'MCP_ADAPTER_INCOMPATIBLE'],
  [{ busy: true }, 'MCP_SESSION_BUSY']
] as const) {
  test(`拒绝 ${code} 而不报告成功`, async () => {
    const h = harness(options)
    assert.equal((await h.configure([service('chat')])).code, code)
    assert.equal(h.replies.at(-1)!.success, false)
    assert.equal(h.notice(), undefined)
    assert.equal(h.active.get('configured'), h.configured)
  })
}

test('恢复旧历史不复用之前的连接凭据，用当前范围说明替代旧能力提示', () => {
  const h = harness({ history: true })
  assert.match(h.notice()!.message!.content, /历史中的 ACP 服务提示不代表本次连接仍提供/)
  assert.equal(h.notice(), undefined)
  assert.equal(h.registrations.length, 0)
})

test('空配置不需要 MCP adapter，也不创建额外注册', async () => {
  const h = harness({ missing: true })
  assert.equal((await h.configure([])).success, true)
  assert.equal(h.registrations.length, 0)
})

test('关闭后的注册请求被拒绝', async () => {
  const h = harness()
  await h.hooks.get('session_shutdown')!({}, h.ctx)
  assert.equal((await h.configure([service('chat')])).code, 'MCP_BRIDGE_UNAVAILABLE')
  assert.equal(h.registrations.length, 0)
})
