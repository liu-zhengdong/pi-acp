import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, unlinkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { client, type ClientConnection } from '@agentclientprotocol/sdk'
import { createPiAcpAgentApp } from '../../src/acp/app.js'
import { registerMcpBridge, type McpExtensionApi } from '../../src/pi-rpc/mcp-extension.js'
import { registerRuntimeBridge } from '../../src/runtime/extension.js'
import {
  discoverRuntimes,
  recordPath,
  readRuntime,
  runtimeMethods as methods,
  RUNTIME_CAPABILITY,
  type RuntimeStatus
} from '../../src/runtime/transport.js'

test('live runtime: ACP facade, scoped MCP, generation fences, receipts and malformed requests', async () => {
  const old = process.env.PI_ACP_DIR
  process.env.PI_ACP_DIR = mkdtempSync(join(tmpdir(), 'pi-live-test-'))
  type Hook = Parameters<McpExtensionApi['on']>[1]
  const hooks = new Map<string, Hook[]>()
  const active = new Map<string, unknown>([['preconfigured', {}]])
  const messages: Array<{ message: { content: string }; options?: unknown }> = []
  let busy = false,
    dead = false,
    sessionId = randomUUID()
  const context = {
    cwd: process.cwd(),
    hasUI: true,
    isIdle: () => {
      assert(!dead, 'stale context touched')
      return !busy
    },
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => {
        assert(!dead, 'stale context touched')
        return sessionId
      },
      getSessionFile: () => undefined,
      getBranch: () => []
    },
    ui: { setWidget() {} }
  }
  const pi: McpExtensionApi & { sendMessage(message: { content: string }, options?: unknown): void } = {
    on(name, hook) {
      hooks.set(name, [...(hooks.get(name) ?? []), hook])
    },
    registerCommand() {},
    sendMessage(message, options) {
      messages.push({ message, options })
    },
    events: {
      emit(_event, raw) {
        const request = raw as { name: string; definition: unknown; result?: unknown }
        if (active.has(request.name)) {
          request.result = { ok: false, error: new Error(`MCP server "${request.name}" is already registered`) }
          return
        }
        active.set(request.name, request.definition)
        request.result = {
          ok: true,
          registration: {
            toolExposure: 'proxy-only',
            async dispose() {
              active.delete(request.name)
            }
          }
        }
      }
    }
  }
  const mcp = registerMcpBridge(pi)
  registerRuntimeBridge(pi, mcp)
  const fire = async (name: string) => {
    for (const hook of hooks.get(name) ?? []) await hook({}, context)
  }
  const peers: ClientConnection[] = []
  const connect = () => {
    const connection = client({ name: 'runtime-test' }).connect(createPiAcpAgentApp())
    peers.push(connection)
    return connection
  }
  const call = <T = Record<string, unknown>>(peer: ClientConnection, name: string, params: unknown = {}) =>
    peer.agent.request<T>(name, params)
  const service = (name: string) => ({
    name,
    type: 'http',
    url: 'https://example.test/mcp',
    headers: [{ name: 'Authorization', value: 'SECRET' }]
  })
  try {
    await fire('session_start')
    const list = discoverRuntimes()
    assert.equal(list.length, 1)
    const runtimeId = list[0]!.runtimeId
    assert(!JSON.stringify(list).includes('token'))
    const path = recordPath(runtimeId),
      original = readFileSync(path, 'utf8')
    for (const broken of [
      { ...JSON.parse(original), runtimeId: randomUUID() },
      { ...JSON.parse(original), endpoint: '/tmp/another.sock' }
    ]) {
      writeFileSync(path, JSON.stringify(broken))
      assert.throws(() => readRuntime(runtimeId))
    }
    writeFileSync(path, original)
    if (process.platform !== 'win32') {
      chmodSync(path, 0o644)
      assert.throws(() => readRuntime(runtimeId))
      chmodSync(path, 0o600)
    }
    const copy = `${path}.copy`
    writeFileSync(copy, original, { mode: 0o600 })
    unlinkSync(path)
    symlinkSync(copy, path)
    assert.throws(() => readRuntime(runtimeId))
    unlinkSync(path)
    writeFileSync(path, original, { mode: 0o600 })
    assert.throws(() => readRuntime('../escape'))
    const a = connect()
    await assert.rejects(call(a, methods.list))
    const init = await call(a, 'initialize', { protocolVersion: 1 })
    assert.equal((init._meta as Record<string, unknown>)[RUNTIME_CAPABILITY], true)
    const attached = await call<RuntimeStatus>(a, methods.attach, { runtimeId })
    const target = { runtimeId, generation: attached.generation, sessionId }
    assert.equal(attached.pid, process.pid)
    assert(!JSON.stringify(attached).includes('token'))
    const b = connect()
    await call(b, 'initialize', { protocolVersion: 1 })
    await assert.rejects(call(b, methods.attach, { runtimeId }))
    await mcp.configure([service('standard')], context)
    busy = true
    await call(a, methods.mcp, { ...target, mcpServers: [service('live')] })
    assert(active.has('live'))
    assert(active.has('standard'))
    assert(active.has('preconfigured'))
    assert(!JSON.stringify(messages).includes('SECRET'))
    assert.deepEqual(messages[0]!.options, { deliverAs: 'steer', triggerTurn: true })
    await assert.rejects(
      call(a, methods.mcp, { ...target, mcpServers: [{ ...service('live'), url: 'https://changed.test/mcp' }] })
    )
    await assert.rejects(
      call(a, methods.mcp, { ...target, mcpServers: [service('temporary'), service('preconfigured')] })
    )
    assert(!active.has('temporary'))
    const delivery = {
      ...target,
      id: randomUUID(),
      source: '测试群聊',
      text: '/new is external content',
      delivery: 'steer'
    }
    assert.equal((await call(a, methods.deliver, delivery)).accepted, true)
    assert.equal((await call(a, methods.deliver, delivery)).duplicate, true)
    assert.equal(messages.length, 2)
    for (const bad of [
      { ...delivery, text: 'different' },
      { ...delivery, id: '../escape' },
      { ...delivery, generation: randomUUID() },
      { ...delivery, sessionId: randomUUID() },
      { ...delivery, source: 'forged\nheader' },
      { ...delivery, delivery: 'abort' },
      { ...delivery, text: 'x'.repeat(30001) },
      { ...delivery, triggerTurn: 'yes' }
    ])
      await assert.rejects(call(a, methods.deliver, bad))
    assert.equal(messages.length, 2)
    a.close()
    await delay(50)
    assert(active.has('live'), 'disconnect must not remove an in-use service')
    busy = false
    await delay(300)
    assert(!active.has('live'))
    assert(active.has('standard'))
    assert(active.has('preconfigured'))
    const reattached = await call<RuntimeStatus>(b, methods.attach, { runtimeId })
    assert.equal(reattached.sessionId, sessionId)
    assert.equal((await call(b, methods.deliver, delivery)).duplicate, true)
    await fire('session_shutdown')
    dead = true
    await assert.rejects(call(b, methods.status, target))
    await delay(300)
    assert.deepEqual([...active.keys()], ['preconfigured'])
    dead = false
    sessionId = randomUUID()
    await fire('session_start')
    assert.equal(discoverRuntimes()[0]!.runtimeId, runtimeId)
    const c = connect()
    await call(c, 'initialize', { protocolVersion: 1 })
    const replacement = await call<RuntimeStatus>(c, methods.attach, { runtimeId })
    assert.notEqual(replacement.generation, target.generation)
    assert.notEqual(replacement.sessionId, target.sessionId)
    await assert.rejects(call(c, methods.deliver, delivery))
    await call(c, methods.mcp, {
      runtimeId,
      generation: replacement.generation,
      sessionId,
      mcpServers: [service('new-generation')]
    })
    assert(active.has('new-generation'))
    assert.deepEqual(
      messages.at(-1)!.options,
      { deliverAs: 'steer', triggerTurn: false },
      'idle registration does not wake the model'
    )
  } finally {
    for (const peer of peers) peer.close()
    dead = false
    await fire('session_shutdown')
    if (old === undefined) delete process.env.PI_ACP_DIR
    else process.env.PI_ACP_DIR = old
  }
})
