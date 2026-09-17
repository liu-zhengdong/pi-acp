import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { withSmokeAgent, smokePrompt } from './smoke-client.mjs'
import { fixtureMcp } from './fixtures/mcp-echo.mjs'

// 使用真实 Pi 和已安装的 adapter；只有模型输出与业务工具是本地确定性夹具。
const extension = process.env.PI_ACP_MCP_EXTENSION
if (!extension) throw new Error('请设置 PI_ACP_MCP_EXTENSION，指向已安装 pi-mcp-adapter 的 index.ts')
const adapter = realpathSync(resolve(extension))
const root = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-smoke-'))
const profile = join(root, 'profile')
const cwd = join(root, 'project')
mkdirSync(profile)
mkdirSync(cwd)
mkdirSync(join(root, 'source'))
const fixture = fileURLToPath(new URL('./fixtures/mcp-echo.mjs', import.meta.url))
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const sourceHashes = {}
for (const [name, path] of [
  ['smoke-mcp.mjs', fileURLToPath(import.meta.url)],
  ['mcp-echo.mjs', fixture],
  ['acp-extension.js', resolve('dist/acp-extension.js')],
  ['adapter-index.ts', adapter]
]) {
  copyFileSync(path, join(root, 'source', name))
  sourceHashes[name] = hash(path)
}
writeFileSync(join(root, 'source-hashes.json'), JSON.stringify(sourceHashes, null, 2))
const payloads = []
const calls = []
const clients = []
const sse = new Map()
const token = 'fixture-mcp-secret-do-not-inject'
const replyHttp = fixtureMcp('http', call => calls.push(call))
const replySse = fixtureMcp('sse', call => calls.push(call))
const endpoint = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/sse' && req.method === 'GET') {
      assert.equal(req.headers.authorization, `Bearer ${token}`)
      const id = randomUUID()
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`event: endpoint\ndata: /sse-message?id=${id}\n\n`)
      sse.set(id, res)
      res.on('close', () => sse.delete(id))
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (url.pathname === '/mcp' || url.pathname === '/sse-message') {
      assert.equal(req.headers.authorization, `Bearer ${token}`)
      const response = (url.pathname === '/mcp' ? replyHttp : replySse)(body)
      if (url.pathname === '/sse-message') {
        if (response)
          sse.get(url.searchParams.get('id'))?.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`)
        res.writeHead(202).end()
      } else if (response) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response))
      else res.writeHead(202).end()
      return
    }
    assert.equal(url.pathname, '/v1/chat/completions')
    payloads.push(body)
    assert.ok(payloads.length <= 16, '模型请求次数超过限制')
    const tasks = body.messages
      .map((message, index) => ({ index, text: JSON.stringify(message.content) }))
      .filter(message => /SMOKE_(FIRST|DYNAMIC|HTTP|SSE|RESTORE)/.test(message.text))
    const task = tasks.at(-1)
    assert.ok(task, '没有识别到当前验收任务')
    const hasResult = body.messages.slice(task.index + 1).some(message => message.role === 'tool')
    const names = /FIRST/.test(task.text)
      ? [
          ['provided', 'echo'],
          ['existing', 'echo']
        ]
      : /DYNAMIC/.test(task.text)
        ? [['provided', 'extra']]
        : /HTTP/.test(task.text)
          ? [['http', 'echo']]
          : /SSE/.test(task.text)
            ? [['sse', 'echo']]
            : [['provided', 'echo']]
    const toolCalls = names.map(([server, tool], index) => ({
      index,
      id: `call_${payloads.length}_${index}`,
      type: 'function',
      function: { name: 'mcp', arguments: JSON.stringify({ server, tool, args: { message: '中文往返成功' } }) }
    }))
    const base = {
      id: `fixture_${payloads.length}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'scripted'
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: hasResult ? { role: 'assistant', content: '已收到工具返回。' } : { role: 'assistant', tool_calls: toolCalls }, finish_reason: null }] })}\n\n`
    )
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: hasResult ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
    )
    res.end('data: [DONE]\n\n')
  } catch (error) {
    calls.push({ error: error.message })
    res.writeHead(500).end(JSON.stringify({ error: { message: error.message } }))
  }
})
endpoint.listen(0, '127.0.0.1')
await once(endpoint, 'listening')
const baseUrl = `http://127.0.0.1:${endpoint.address().port}`
const settings = { defaultProvider: 'mcp-smoke', defaultModel: 'scripted', extensions: [adapter] }
writeFileSync(join(profile, 'settings.json'), JSON.stringify(settings))
writeFileSync(
  join(profile, 'models.json'),
  JSON.stringify({
    providers: {
      'mcp-smoke': {
        baseUrl: `${baseUrl}/v1`,
        api: 'openai-completions',
        apiKey: 'local-fixture-key',
        models: [
          {
            id: 'scripted',
            name: '本地确定性模型夹具',
            reasoning: false,
            input: ['text'],
            contextWindow: 32768,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }
        ]
      }
    }
  })
)
writeFileSync(
  join(profile, 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      existing: { command: process.execPath, args: [fixture], env: { FIXTURE_NAME: 'existing' }, directTools: false }
    }
  })
)
const configHash = hash(join(profile, 'mcp.json'))
const servers = [
  { name: 'provided', command: process.execPath, args: [fixture], env: [{ name: 'FIXTURE_NAME', value: 'provided' }] },
  ...['http', 'sse'].map(type => ({
    name: type,
    type,
    url: `${baseUrl}/${type === 'http' ? 'mcp' : 'sse'}`,
    headers: [{ name: 'Authorization', value: `Bearer ${token}` }]
  }))
]
const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: profile,
  PI_MCP_CONFIG_MODE: 'exclusive',
  PI_ACP_SESSION_MAP: join(root, 'session-map.json')
}
const initialize = client => client.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
const options = {
  env,
  timeoutMs: 90_000,
  onRequest(message, client) {
    assert.equal(message.method, 'session/request_permission')
    const option = message.params.options.find(item => item.kind === 'allow_once')
    assert.ok(option)
    client.respond(message.id, { outcome: { outcome: 'selected', optionId: option.optionId } })
  }
}
let summary
try {
  await withSmokeAgent(async client => {
    clients.push(client.messages)
    const initialized = await initialize(client)
    assert.deepEqual(initialized.agentCapabilities.mcpCapabilities, { http: true, sse: true })
    const rejected = [
      [{ ...servers[0], name: 'existing' }],
      [
        { ...servers[0], name: 'partial' },
        { ...servers[0], name: 'existing' }
      ],
      [{ ...servers[1], type: 'unsupported' }]
    ]
    for (const mcpServers of rejected) await assert.rejects(client.request('session/new', { cwd, mcpServers }))
    assert.equal(payloads.length, 0, '注册失败不应触发模型调用')
    const session = await client.request('session/new', { cwd, mcpServers: servers })
    for (const task of ['FIRST', 'DYNAMIC', 'HTTP', 'SSE']) {
      // 当前 MCP SDK 对 tools/list_changed 去抖 300ms；不把消息送达当作目录刷新已完成。
      if (task === 'DYNAMIC') await delay(1000)
      await smokePrompt(client, session.sessionId, `SMOKE_${task}`)
    }
    await client.request('session/close', { sessionId: session.sessionId })
    const response = await client.request('session/resume', { cwd, sessionId: session.sessionId, mcpServers: servers })
    assert.ok(response)
    await smokePrompt(client, session.sessionId, 'SMOKE_RESTORE')
    const serial = JSON.stringify(client.messages)
    for (const result of ['provided.echo', 'existing.echo', 'provided.extra', 'http.echo', 'sse.echo'])
      assert.ok(serial.includes(`${result}:中文往返成功`), `没有找到真实工具结果 ${result}`)
    assert.equal(hash(join(profile, 'mcp.json')), configHash, '原有 MCP 配置发生了变化')
    assert.ok(payloads.length >= 10)
    const firstTools = JSON.stringify(payloads[0].tools)
    for (const payload of payloads)
      assert.equal(JSON.stringify(payload.tools), firstTools, '业务工具变化导致模型 tools 定义变化')
    assert.ok(payloads[0].tools.some(tool => tool.function.name === 'mcp'))
    assert.ok(
      !payloads[0].tools.some(tool => ['echo', 'extra', 'provided_echo', 'provided_extra'].includes(tool.function.name))
    )
    const messages = JSON.stringify(payloads.flatMap(payload => payload.messages))
    assert.ok(messages.includes('本次 ACP 连接额外提供的 MCP 服务'))
    assert.ok(!messages.includes(token), '凭据泄漏进模型上下文')
    const system = JSON.stringify(
      payloads[0].messages.filter(message => message.role === 'system' || message.role === 'developer')
    )
    for (const payload of payloads)
      assert.equal(
        JSON.stringify(payload.messages.filter(message => message.role === 'system' || message.role === 'developer')),
        system
      )
    summary = {
      passed: true,
      model: '本地确定性夹具；未调用外部模型',
      providerRequests: payloads.length,
      transports: ['stdio', 'streamable-http', 'sse'],
      rejected: ['重名', '部分注册后重名', '不支持的传输'],
      sourceHashes
    }
  }, options)
} finally {
  writeFileSync(join(root, 'provider-requests.json'), JSON.stringify(payloads, null, 2))
  writeFileSync(join(root, 'acp-transcript.json'), JSON.stringify(clients, null, 2))
  writeFileSync(join(root, 'http-tools.json'), JSON.stringify(calls, null, 2))
  for (const [name, expected] of Object.entries(sourceHashes)) assert.equal(hash(join(root, 'source', name)), expected)
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary ?? { passed: false, sourceHashes }, null, 2))
  for (const response of sse.values()) response.end()
  endpoint.closeAllConnections()
  await new Promise(resolve => endpoint.close(resolve))
  console.log(`MCP 验收证据：${root}`)
}
console.log(JSON.stringify(summary, null, 2))
