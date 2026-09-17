import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import {
  parseMcpServers,
  mcpDefinition,
  MAX_MCP_REQUEST_BYTES,
  McpConfigurationError
} from '../../src/pi-rpc/mcp-servers.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const http = {
  name: 'chat',
  type: 'http',
  url: 'https://example.test/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer SECRET' }]
}
const stdio = {
  name: 'local',
  command: '/usr/bin/env',
  args: ['node', 'server.mjs'],
  env: [{ name: 'TOKEN', value: '${LITERAL}' }]
}

test('ACP MCP 描述转换保留传输和凭据语义，并强制代理模式', () => {
  const parsed = parseMcpServers([stdio, http, { ...http, name: 'legacy', type: 'sse' }])
  assert.deepEqual(mcpDefinition(parsed[0]!), {
    command: '/usr/bin/env',
    args: ['node', 'server.mjs'],
    env: { TOKEN: '${LITERAL}' },
    literalEnv: true,
    inheritEnv: false,
    directTools: false
  })
  assert.deepEqual(mcpDefinition(parsed[1]!), {
    url: http.url,
    headers: { Authorization: 'Bearer SECRET' },
    httpTransport: 'streamable-http',
    directTools: false
  })
  assert.equal(mcpDefinition(parsed[2]!).httpTransport, 'sse')
  assert.deepEqual(parseMcpServers(undefined), [])
  assert.deepEqual(parseMcpServers([]), [])
  http.headers[0]!.value = 'Bearer CHANGED'
  assert.equal('headers' in parsed[1]! && parsed[1].headers[0]!.value, 'Bearer SECRET')
  http.headers[0]!.value = 'Bearer SECRET'
})

const invalid: Array<[string, unknown]> = [
  ['非数组', {}],
  ['空定义', [null]],
  ['空名称', [{ ...http, name: '' }]],
  ['重复服务', [http, http]],
  ['原型字段', [{ ...http, name: '__proto__' }]],
  ['构造器字段', [{ ...http, name: 'constructor' }]],
  ['名称含换行', [{ ...http, name: 'chat\nSECRET' }]],
  ['未知传输', [{ ...http, type: 'websocket' }]],
  ['文件 URL', [{ ...http, url: 'file:///SECRET' }]],
  ['URL 用户凭据', [{ ...http, url: 'https://user:SECRET@example.test/mcp' }]],
  ['URL 片段', [{ ...http, url: 'https://example.test/mcp#SECRET' }]],
  [
    '重复请求头',
    [
      {
        ...http,
        headers: [
          { name: 'Authorization', value: 'SECRET' },
          { name: 'authorization', value: 'SECRET' }
        ]
      }
    ]
  ],
  ['请求头注入', [{ ...http, headers: [{ name: 'Authorization', value: 'SECRET\r\nInjected: yes' }] }]],
  ['请求头名称注入', [{ ...http, headers: [{ name: 'x\nSECRET', value: '' }] }]],
  ['空命令', [{ ...stdio, command: '' }]],
  ['参数不是字符串', [{ ...stdio, args: [1] }]],
  ['空字节', [{ ...stdio, args: ['SECRET\0'] }]],
  ['环境变量键无效', [{ ...stdio, env: [{ name: 'BAD=KEY', value: 'SECRET' }] }]],
  ['重复环境变量', [{ ...stdio, env: [stdio.env[0], stdio.env[0]] }]],
  ['命令和 URL 混用', [{ ...http, command: 'SECRET' }]],
  ['超大描述', [{ ...stdio, args: ['SECRET'.repeat(Math.ceil(MAX_MCP_REQUEST_BYTES / 6))] }]]
]
for (const [label, value] of invalid) {
  test(`MCP 校验拒绝${label}，错误不泄露输入值`, () => {
    assert.throws(
      () => parseMcpServers(value),
      error => {
        assert.ok(error instanceof McpConfigurationError)
        assert.equal(error.code, 'INVALID_MCP_SERVERS')
        assert.doesNotMatch(error.message, /SECRET|Bearer/)
        return true
      }
    )
  })
}

for (const operation of ['closeSession', 'deleteSession'] as const) {
  test(`${operation} 清理本会话的连接描述，不清理其他会话`, async () => {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const state = agent as unknown as {
      mcpServers: Map<string, unknown>
      beginSessionClose(id: string): Promise<void>
      beginSessionDelete(id: string): Promise<void>
    }
    state[operation === 'closeSession' ? 'beginSessionClose' : 'beginSessionDelete'] = async id => {
      assert.equal(id, 'target')
    }
    state.mcpServers.set('target', [http])
    state.mcpServers.set('other', [stdio])
    await agent[operation]({ sessionId: 'target' })
    assert.equal(state.mcpServers.has('target'), false)
    assert.equal(state.mcpServers.has('other'), true)
    agent.dispose()
  })
}

for (const operation of ['newSession', 'loadSession', 'resumeSession'] as const) {
  test(`${operation} 在启动或查找会话前拒绝畸形 MCP 配置`, async () => {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const request = { cwd: process.cwd(), sessionId: 'does-not-exist', mcpServers: [{ ...http, type: 'unsupported' }] }
    // 仅用于验证来自协议边界的非法输入。
    await assert.rejects(agent[operation](request as never), error => {
      assert.equal((error as { code?: number }).code, -32602)
      assert.equal((error as { data?: { reason?: string } }).data?.reason, 'INVALID_MCP_SERVERS')
      return true
    })
    agent.dispose()
  })
}
