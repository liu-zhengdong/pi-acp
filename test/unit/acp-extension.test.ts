import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import acpExtension from '../../src/pi-rpc/acp-extension.js'

const key = Symbol.for('@agegr/pi-web/session-liveness/v1')
const globals = globalThis as Record<symbol, any>
const tick = () => new Promise(resolve => setTimeout(resolve, 80))

function harness() {
  const hooks = new Map<string, (event: any, ctx: any) => void>()
  const events = new EventEmitter()
  let command!: (args: string, ctx: any) => Promise<void>
  const updates: any[] = []
  const ctx = {
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'session', getSessionFile: () => '/session' },
    ui: { setWidget: (_key: string, lines: string[]) => updates.push(JSON.parse(lines[0]!)) }
  }
  acpExtension({
    events: {
      on: (name, handler) => {
        events.on(name, handler)
        return () => {
          events.off(name, handler)
        }
      },
      emit: (name, data) => {
        events.emit(name, data)
      }
    },
    on: (name, handler) => {
      hooks.set(name, handler)
    },
    registerCommand: (_name, value) => {
      command = value.handler
    }
  })
  return {
    ctx,
    updates,
    events,
    command: (args: string) => command(/^(cancel|check) /.test(args) ? `${args} ${Date.now() + 9_000}` : args, ctx),
    // Simulated native-idle driver; real Pi abort ordering is checked separately.
    async cancel(token: string) {
      const deadline = Date.now() + 9_000
      for (;;) {
        if (Date.now() >= deadline) throw new Error('termination could not be confirmed')
        await command(`cancel ${token} ${deadline}`, ctx)
        await command(`check ${token} ${deadline}`, ctx)
        if (updates.at(-1)?.state === 'cancelled') return
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    },
    emit: (name: string, event: any = {}) => hooks.get(name)?.(event, ctx),
    register: (value: any) => globals[key].register(value)
  }
}
const owner = '11111111-1111-4111-8111-111111111111'

for (const residual of ['pending-delivery', 'last-stop-synthesis', 'nested-descendant']) {
  test(`companion cancellation must not acknowledge terminal root with ${residual}`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] })
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    let live = false
    let pending = false
    let rootState = residual === 'last-stop-synthesis' ? 'running' : 'complete'
    h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => live })
    h.ctx.hasPendingMessages = () => pending
    await h.command(`begin ${owner}`)
    live = true
    pending = residual === 'pending-delivery'
    h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'owned-root' } })
    const stops: string[] = []
    h.events.on('subagents:rpc:v1:request', request => {
      if (request.method === 'stop') {
        stops.push(request.params.id)
        rootState = 'stopped'
        pending = true
      }
      h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data:
          request.method === 'status'
            ? {
                asyncSnapshot: {
                  kind: 'pi-subagents.async-status-snapshot',
                  version: 1,
                  runs: [
                    {
                      id: 'owned-root',
                      state: rootState,
                      ...(residual === 'nested-descendant'
                        ? { children: [{ id: 'nested-live', kind: 'subagent', label: 'nested', state: 'running' }] }
                        : {})
                    }
                  ]
                }
              }
            : { runId: request.params.id }
      })
    })
    await h.command(`cancel ${owner}`)
    await h.command(`check ${owner}`)
    assert.equal(live, true, 'explicit host liveness still reports owned work/delivery')
    assert.equal(pending, residual !== 'nested-descendant')
    assert.deepEqual(stops, residual === 'last-stop-synthesis' ? ['owned-root'] : [])
    assert.equal(
      h.updates.some(update => update.state === 'cancelled'),
      false,
      'terminal root is not proof of delivery, synthesis, or descendant quiescence'
    )
    assert.equal(h.updates.at(-1).state, 'pending')
    live = false
    h.ctx.isIdle = () => false
    pending = true
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, 'pending', 'native synthesis must settle too')
    h.ctx.isIdle = () => true
    pending = false
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, 'cancelled')
  })
}

test('companion holds exact session through pending delivery and queued synthesis; coexists with host registry', async () => {
  let registrations = 0
  const previous = {
    version: 1,
    register: () => {
      registrations++
      return () => {
        registrations--
      }
    }
  }
  globals[key] = previous
  const h = harness()
  let active = false
  const release = h.register({
    name: 'pi-subagents',
    sessionId: 'session',
    sessionFile: '/session',
    isActive: () => active
  })
  h.register({ name: 'pi-subagents', sessionId: 'foreign', isActive: () => true })
  await h.command(`begin ${owner}`)
  active = true
  h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'owned-run' } })
  assert.equal(h.updates.at(-1).state, 'active')
  await tick()
  assert.equal(h.updates.length, 2, 'terminal child with delivery pending remains active')
  active = false
  h.ctx.hasPendingMessages = () => true
  await tick()
  assert.equal(h.updates.length, 2)
  h.ctx.hasPendingMessages = () => false
  await tick()
  assert.deepEqual(h.updates.at(-1), { version: 1, owner, state: 'idle' })
  release()
  assert.equal(registrations, 1)
  h.emit('session_shutdown')
  assert.equal(globals[key], previous)
  delete globals[key]
})

test('companion keeps successive background work alive beyond 30 minutes', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
  const h = harness()
  t.after(() => h.emit('session_shutdown'))
  let busy = false
  h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => busy })
  await h.command(`begin ${owner}`)
  busy = true
  h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'first' } })
  t.mock.timers.tick(9 * 60_000)
  busy = false
  h.ctx.isIdle = () => false
  t.mock.timers.tick(16 * 60_000)
  busy = true
  h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'second' } })
  h.ctx.isIdle = () => true
  t.mock.timers.tick(5 * 60_000 + 50)
  assert.deepEqual(
    h.updates.map(update => update.state),
    ['ready', 'active']
  )
  t.mock.timers.tick(60 * 60_000)
  assert.equal(h.updates.at(-1).state, 'active', 'a single long-running job has no adapter runtime cap either')
  busy = false
  h.ctx.isIdle = () => false
  t.mock.timers.tick(50)
  assert.equal(h.updates.at(-1).state, 'active', 'native synthesis still holds the prompt')
  h.ctx.isIdle = () => true
  h.ctx.hasPendingMessages = () => true
  t.mock.timers.tick(50)
  assert.equal(h.updates.at(-1).state, 'active', 'pending delivery still holds the prompt')
  h.ctx.hasPendingMessages = () => false
  t.mock.timers.tick(50)
  assert.equal(h.updates.at(-1).state, 'idle', 'only authoritative quiescence releases the prompt')
  await h.command(`begin ${owner}`)
  assert.equal(h.updates.at(-1).state, 'ready')
})

test('companion stops only owned live IDs, skips proven terminal IDs, rejects foreign ownership', async () => {
  const h = harness()
  let active = false
  h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => active })
  await h.command(`begin ${owner}`)
  active = true
  for (const id of ['live', 'terminal']) h.emit('tool_result', { toolName: 'subagent', details: { asyncId: id } })
  const stopped: string[] = []
  h.events.on('subagents:rpc:v1:request', request => {
    let data
    if (request.method === 'status')
      data = {
        asyncSnapshot: {
          kind: 'pi-subagents.async-status-snapshot',
          version: 1,
          runs: [
            { id: 'live', state: active ? 'running' : 'stopped' },
            { id: 'terminal', state: 'complete' },
            { id: 'foreign', state: 'running' }
          ]
        }
      }
    else {
      stopped.push(request.params.id)
      active = false
      data = { runId: request.params.id }
    }
    h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
      data
    })
  })
  await assert.rejects(h.cancel('foreign'), /Invalid ACP lifecycle owner/)
  await h.cancel(owner)
  assert.deepEqual(stopped, ['live'])
  assert.equal(h.updates.at(-1).state, 'cancelled')
  h.emit('session_shutdown')
})

test('missing/older liveness contract is a visible failure, not silent successful async completion', async () => {
  const h = harness()
  await h.command(`begin ${owner}`)
  h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'owned' } })
  assert.match(h.updates.at(-1).error, /did not register/)
  await h.command(`begin ${owner}`)
  assert.equal(h.updates.at(-1).state, 'rejected', 'unknown owned work must not be forgotten')
  let busy = true
  h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => busy })
  await tick()
  await h.command(`begin ${owner}`)
  assert.equal(h.updates.at(-1).state, 'rejected')
  busy = false
  await tick()
  await h.command(`begin ${owner}`)
  assert.equal(h.updates.at(-1).state, 'ready', 'authoritatively drained work permits recovery')
  h.emit('session_shutdown')
})

test('stop rejection and missing RPC replies are explicit failures, never successful drain', async () => {
  for (const respond of [true, false]) {
    const h = harness()
    let active = false
    h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => active })
    await h.command(`begin ${owner}`)
    active = true
    h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'owned' } })
    if (respond)
      h.events.on('subagents:rpc:v1:request', request => {
        h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          version: 1,
          requestId: request.requestId,
          success: false,
          error: { message: 'denied' }
        })
      })
    await assert.rejects(
      h.cancel(owner),
      respond ? /pi-subagents status failed: denied/ : /pi-subagents status timed out$/
    )
    assert.equal(h.updates.at(-1).state, 'error')
    h.emit('session_shutdown')
  }
})

test('pre-existing same-session work is not adopted; ordinary Pi needs no optional provider', async () => {
  const h = harness()
  await h.command(`begin ${owner}`)
  h.emit('agent_end')
  h.emit('agent_settled')
  assert.equal(h.updates.at(-1).state, 'ready')
  let busy = true
  h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => busy })
  await h.command(`begin ${owner}`)
  assert.equal(h.updates.at(-1).state, 'rejected')
  assert.match(h.updates.at(-1).error, /Pre-existing or restored background work.*wait.*or open a new session/)
  busy = false
  await h.command(`begin ${owner}`)
  assert.equal(h.updates.at(-1).state, 'ready')
  h.emit('session_shutdown')
})

for (const drain of [true, false]) {
  test(`companion cancellation keeps its deadline after long-running work and slow status/stop/drain (${drain})`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] })
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    let busy = false
    h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => busy })
    await h.command(`begin ${owner}`)
    busy = true
    h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'owned' } })
    t.mock.timers.tick(60 * 60_000)
    assert.equal(h.updates.at(-1).state, 'active')
    let requests = 0
    h.events.on('subagents:rpc:v1:request', request => {
      requests++
      setTimeout(
        () => {
          h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
            version: 1,
            requestId: request.requestId,
            success: true,
            data:
              request.method === 'status'
                ? {
                    asyncSnapshot: {
                      kind: 'pi-subagents.async-status-snapshot',
                      version: 1,
                      runs: [{ id: 'owned', state: busy ? 'running' : 'stopped' }]
                    }
                  }
                : { runId: 'owned' }
          })
        },
        requests <= 2 ? 4000 : 0
      )
    })
    const pending = h.cancel(owner)
    const result = drain ? pending : assert.rejects(pending, /termination could not be confirmed/)
    for (let i = 0; i < 2; i++) {
      t.mock.timers.tick(4000)
      await new Promise(resolve => setImmediate(resolve))
    }
    if (drain) busy = false
    for (let i = 0; i < (drain ? 5 : 10); i++) {
      t.mock.timers.tick(100)
      await new Promise(resolve => setImmediate(resolve))
    }
    await result
    assert.equal(
      h.updates.some(update => update.state === 'cancelled'),
      drain
    )
    assert.equal(h.updates.at(-1).state, drain ? 'cancelled' : 'pending')
    h.emit('session_shutdown')
  })
}

for (const transition of ['invalid_state', 'not_found', 'unrelated']) {
  test(`owned cancellation retries ${transition} and retains exact terminal IDs while aggregate liveness is inconclusive`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] })
    const h = harness()
    let busy = false
    h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => busy })
    await h.command(`begin ${owner}`)
    busy = true
    h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'owned' } })
    let stops = 0
    let state = transition === 'unrelated' ? 'running' : 'queued'
    h.events.on('subagents:rpc:v1:request', request => {
      const reply = {
        version: 1,
        requestId: request.requestId,
        success: true,
        data: {} as any,
        error: undefined as any
      }
      if (request.method === 'status')
        reply.data = {
          asyncSnapshot: {
            kind: 'pi-subagents.async-status-snapshot',
            version: 1,
            runs: [
              { id: 'owned', state },
              { id: 'foreign', state: 'running' }
            ]
          }
        }
      else {
        assert.equal(request.params.id, 'owned')
        stops++
        if (stops === 1 && transition !== 'unrelated') {
          reply.success = false
          reply.error = {
            code: transition,
            message:
              transition === 'not_found'
                ? "Status file not found for async run 'owned'."
                : 'Async run owned is queued; stop only supports running async runs.'
          }
          state = 'running'
        } else {
          state = 'stopped'
          reply.data = { runId: 'owned' }
        }
      }
      h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, reply)
    })
    let error: unknown
    const pending = h.cancel(owner).catch(e => {
      error = e
    })
    for (let i = 0; i < 12; i++) {
      t.mock.timers.tick(1000)
      await new Promise(resolve => setImmediate(resolve))
    }
    await pending
    h.emit('session_shutdown')
    assert.match(String(error), /termination could not be confirmed/)
    assert.equal(stops, transition === 'unrelated' ? 1 : 2)
    assert.ok(!h.updates.some(update => update.state === 'cancelled'))
    assert.equal(busy, true, 'unrelated liveness is unknown ownership, never stop authority')
  })
}

for (const failure of ['omitted', 'wrong-session', 'permission', 'malformed']) {
  test(`companion never claims cancellation on ${failure} status/stop`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] })
    const h = harness()
    let busy = false
    h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => busy })
    await h.command(`begin ${owner}`)
    busy = true
    h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'owned' } })
    let stops = 0
    h.events.on('subagents:rpc:v1:request', request => {
      const reply = {
        version: 1,
        requestId: request.requestId,
        success: true,
        data: {} as any,
        error: undefined as any
      }
      if (request.method === 'status')
        reply.data = {
          asyncSnapshot: {
            kind: 'pi-subagents.async-status-snapshot',
            version: 1,
            runs: failure === 'omitted' ? [] : [{ id: 'owned', state: 'running' }]
          }
        }
      else {
        stops++
        reply.success = failure === 'malformed'
        reply.error =
          failure === 'wrong-session'
            ? { code: 'not_found', message: "Async run 'owned' was not found in the active session." }
            : { code: 'permission_denied', message: 'denied' }
      }
      h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, reply)
    })
    const result = assert.rejects(
      h.cancel(owner),
      failure === 'omitted' ? /termination could not be confirmed/ : /stop failed/
    )
    for (let i = 0; i < 10; i++) {
      t.mock.timers.tick(1000)
      await new Promise(resolve => setImmediate(resolve))
    }
    await result
    assert.equal(stops, failure === 'omitted' ? 0 : 1)
    assert.ok(!h.updates.some(update => update.state === 'cancelled'))
    h.emit('session_shutdown')
  })
}

test('companion retains owner across native settlement and repeated post-stop tool results', async () => {
  const h = harness()
  let busy = false
  h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => busy })
  await h.command(`begin ${owner}`)
  h.emit('agent_settled')
  await h.cancel(owner)
  busy = true
  h.emit('tool_result', { toolName: 'subagent', details: { asyncId: 'late' } })
  h.events.on('subagents:rpc:v1:request', request => {
    h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
      data: {
        asyncSnapshot: {
          kind: 'pi-subagents.async-status-snapshot',
          version: 1,
          runs: [{ id: 'late', state: 'stopped' }]
        }
      }
    })
  })
  await h.command(`cancel ${owner}`)
  await h.command(`check ${owner}`)
  assert.equal(h.updates.at(-1).state, 'pending')
  await h.command(`begin ${owner}`)
  assert.equal(h.updates.at(-1).state, 'rejected', 'unconfirmed ownership must not be forgotten')
  busy = false
  await h.command(`check ${owner}`)
  assert.equal(h.updates.at(-1).state, 'cancelled')
  h.emit('session_shutdown')
})

const ownedRoot = '22222222-2222-4222-8222-222222222222'
const nestedId = '33333333-3333-4333-8333-333333333333'
const deeperId = '44444444-4444-4444-8444-444444444444'
const routeRoot = '55555555-5555-4555-8555-555555555555'
const foreignRoot = '66666666-6666-4666-8666-666666666666'
function statusHeaders(id: string, parent = ownedRoot, root = routeRoot, state = 'running') {
  return `Status target: run ${id}\nSpawn budget: unlimited\nActive async capacity: 0/unlimited used\nNested run: ${id}\nRoot: ${root}\nParent: ${parent} step 1\nState: ${state}\nAgent: fixture`
}

for (const method of ['status', 'interrupt']) {
  test(`companion reconciles stock nested ${method} execution_failed across owned roots`, async t => {
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    let live = false
    let stale = true
    let terminal = false
    h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => live })
    await h.command(`begin ${owner}`)
    live = true
    for (const asyncId of [ownedRoot, foreignRoot])
      h.emit('tool_result', { toolName: 'subagent', details: { asyncId } })
    const stops: string[] = []
    const interrupts: string[] = []
    const targeted: string[] = []
    h.events.on('subagents:rpc:v1:request', request => {
      const id = request.params.id
      if (request.method === 'status' && id) targeted.push(id)
      if (request.method === 'interrupt') interrupts.push(id)
      if (request.method === method && id === nestedId && stale) {
        h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          version: 1,
          requestId: request.requestId,
          success: false,
          error: {
            code: 'execution_failed',
            message:
              method === 'status'
                ? 'Async run not found. Provide id or dir.'
                : `Nested run ${id} is already complete and cannot be interrupted.`
          }
        })
        return
      }
      if (request.method === 'stop') stops.push(id)
      h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data:
          request.method === 'status'
            ? id
              ? {
                  text: statusHeaders(
                    id,
                    id === nestedId ? ownedRoot : foreignRoot,
                    routeRoot,
                    stale ? 'running' : 'complete'
                  )
                }
              : {
                  asyncSnapshot: {
                    kind: 'pi-subagents.async-status-snapshot',
                    version: 1,
                    caps: { maxStringLength: 160 },
                    runs: [ownedRoot, foreignRoot].map((root, index) => ({
                      id: root,
                      state: terminal ? 'complete' : 'running',
                      children: [{ id: index === 0 ? nestedId : deeperId, kind: 'subagent', state: 'running' }]
                    }))
                  }
                }
            : { runId: id }
      })
    })
    await h.command(`cancel ${owner}`)
    assert.deepEqual(stops, [ownedRoot, foreignRoot], 'a stale descendant must not skip either owned root stop')
    assert.ok(interrupts.includes(deeperId), 'the next owned root still receives nested control')
    assert.match(h.updates.at(-1).error, /pi-subagents (status|interrupt) failed/)
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, 'pending')
    assert.match(h.updates.at(-1).error, /not found|already complete/)
    stale = false
    terminal = true
    await h.command(`cancel ${owner}`)
    assert.equal(targeted.filter(id => id === nestedId).length, 2, 're-observe failed targets on the next pass')
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, 'pending', 'terminal records still cannot replace aggregate quiescence')
    live = false
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, 'cancelled')
    assert.equal(h.updates.at(-1).error, undefined, 'independent quiescence resolves the unconfirmed outcome')
  })
}

for (const method of ['status', 'interrupt']) {
  for (const code of ['invalid_params', 'unsupported_method', 'no_active_session', 'denied', undefined]) {
    test(`companion preserves fatal nested ${method} rejection: ${code ?? 'malformed reply'}`, async t => {
      const h = harness()
      t.after(() => h.emit('session_shutdown'))
      let live = false
      h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => live })
      await h.command(`begin ${owner}`)
      live = true
      h.emit('tool_result', { toolName: 'subagent', details: { asyncId: ownedRoot } })
      h.events.on('subagents:rpc:v1:request', request => {
        const fail = request.method === method && request.params.id === nestedId
        h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          version: 1,
          requestId: request.requestId,
          ...(fail
            ? { success: false, error: { code, message: 'rejected control' } }
            : {
                success: true,
                data: request.params.id
                  ? { text: statusHeaders(nestedId) }
                  : {
                      asyncSnapshot: {
                        kind: 'pi-subagents.async-status-snapshot',
                        version: 1,
                        caps: { maxStringLength: 160 },
                        runs: [{ id: ownedRoot, state: 'complete', children: [{ id: nestedId, kind: 'subagent' }] }]
                      }
                    }
              })
        })
      })
      await assert.rejects(h.command(`cancel ${owner}`), /rejected control/)
      assert.equal(h.updates.at(-1).state, 'error')
      assert.equal(
        h.updates.some(update => update.state === 'cancelled'),
        false
      )
    })
  }
}

for (const shape of [
  'direct',
  'deep-live-parent',
  'sibling-routes',
  'deep-terminal-parent',
  'wrong-parent',
  'wrong-route',
  'missing-parent',
  'cycle',
  'stale',
  'stale-status',
  'stale-interrupt',
  'normalized',
  'truncated',
  'injected',
  'duplicate',
  'control',
  'foreign-sibling'
]) {
  test(`companion verifies canonical nested ancestry before interrupt: ${shape}`, async t => {
    const h = harness()
    t.after(() => h.emit('session_shutdown'))
    let live = false
    h.register({ name: 'pi-subagents', sessionId: 'session', isActive: () => live })
    await h.command(`begin ${owner}`)
    live = true
    h.emit('tool_result', { toolName: 'subagent', details: { asyncId: ownedRoot } })
    const nested = { id: nestedId, kind: 'subagent', state: 'running' }
    const deeper = { id: deeperId, kind: 'subagent', state: 'running' }
    const children = shape === 'missing-parent' ? [deeper] : shape === 'direct' ? [nested] : [nested, deeper]
    const controls: string[] = []
    h.events.on('subagents:rpc:v1:request', request => {
      let data: object
      if (
        (shape === 'stale-status' && request.method === 'status' && request.params.id) ||
        (shape === 'stale-interrupt' && request.method === 'interrupt')
      ) {
        if (request.method === 'interrupt') controls.push(request.params.id)
        h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          version: 1,
          requestId: request.requestId,
          success: false,
          error: {
            code: 'execution_failed',
            message: 'Target already settled'
          }
        })
        return
      }
      if (request.method === 'interrupt') {
        controls.push(request.params.id)
        data = {}
      } else if (request.params.id) {
        let text =
          request.params.id === deeperId
            ? statusHeaders(
                deeperId,
                shape === 'sibling-routes' ? ownedRoot : nestedId,
                shape === 'wrong-route' || shape === 'sibling-routes' ? foreignRoot : routeRoot
              )
            : statusHeaders(
                nestedId,
                shape === 'wrong-parent' ? foreignRoot : shape === 'cycle' ? deeperId : ownedRoot,
                routeRoot,
                shape === 'deep-terminal-parent' || shape === 'stale' ? 'complete' : 'running'
              )
        if (shape === 'normalized')
          text = text.replace(`Nested run: ${request.params.id}`, `Nested run:  ${request.params.id}`)
        if (shape === 'injected') text = `Agent: fake\n${text}`
        if (shape === 'duplicate') text += `\nRoot: ${foreignRoot}`
        if (shape === 'control') text += '\u001b[0m'
        data = { text }
      } else
        data = {
          asyncSnapshot: {
            kind: 'pi-subagents.async-status-snapshot',
            version: 1,
            caps: { maxStringLength: shape === 'truncated' ? 36 : 160 },
            runs: [
              {
                id: ownedRoot,
                state: 'complete',
                children: shape === 'foreign-sibling' ? [] : shape === 'stale' ? [nested] : children
              },
              { id: foreignRoot, state: 'running', children: [nested] }
            ]
          }
        }
      h.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        success: true,
        data
      })
    })
    await h.command(`cancel ${owner}`)
    assert.equal(h.updates.at(-1).state, 'stopping')
    assert.deepEqual(
      controls.sort(),
      ['deep-live-parent', 'sibling-routes', 'stale-interrupt'].includes(shape)
        ? [nestedId, deeperId]
        : shape === 'deep-terminal-parent'
          ? [deeperId]
          : shape === 'wrong-route' || shape === 'direct'
            ? [nestedId]
            : []
    )
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, 'pending', 'interrupt ACK and root state do not prove quiescence')
    live = false
    await h.command(`check ${owner}`)
    assert.equal(h.updates.at(-1).state, 'cancelled')
  })
}
