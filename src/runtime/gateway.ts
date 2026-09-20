import {
  discoverRuntimes,
  object,
  RuntimeClient,
  runtimeMethods,
  string,
  uuid,
  type RuntimeStatus
} from './transport.js'

import { join } from 'node:path'
import { PiRpcProcess } from '../pi-rpc/process.js'
import { parseIdentity, resolveIdentitySessionFile } from './identity.js'

/** Connection-scoped ACP facade. It never takes ownership of an attached Pi process. */
export class RuntimeGateway {
  private peers = new Map<string, RuntimeClient>()
  private attaching = new Set<string>()
  private closed = false
  private children = new Set<PiRpcProcess>()
  private namedChildren = new Map<string, PiRpcProcess>()
  async stop(value: unknown) {
    const id = uuid(object(value).identityId),
      proc = this.namedChildren.get(id)
    if (!proc) throw new Error('Identity is not owned by this ACP connection')
    proc.dispose()
    await proc.whenTerminated()
    return { stopped: true }
  }
  private starting = new Set<Promise<{ runtimeId: string }>>()
  private abort = new AbortController()
  async start(value: unknown): Promise<{ runtimeId: string }> {
    const pending = this.launch(value)
    this.starting.add(pending)
    try {
      return await pending
    } finally {
      this.starting.delete(pending)
    }
  }
  private async launch(value: unknown): Promise<{ runtimeId: string }> {
    const params = object(value),
      identity = parseIdentity(params),
      cwd = string(params.cwd)
    if (this.closed) throw new Error('ACP connection closing')
    const sessionPath = resolveIdentitySessionFile(
      identity,
      params.sessionFile ? string(params.sessionFile) : undefined
    )
    const proc = await PiRpcProcess.spawn({
      cwd,
      identity,
      agentDirectory: identity.agentDirectory,
      sessionDirectory: join(identity.agentDirectory, 'sessions'),
      sessionPath,
      mcpProxyOnly: true,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      signal: this.abort.signal,
      onProcess: proc => {
        this.children.add(proc)
        this.namedChildren.set(identity.identityId, proc)
        proc.onTermination(() => {
          this.children.delete(proc)
          if (this.namedChildren.get(identity.identityId) === proc) this.namedChildren.delete(identity.identityId)
        })
        if (this.closed) proc.dispose()
      }
    })
    try {
      await proc.getState()
      if (this.closed) throw new Error('ACP connection closed during launch')
      const record = this.list().runtimes.find(r => r.identityId === identity.identityId && r.ownerPid === process.pid)
      if (!record) throw new Error('Named runtime did not register its identity')
      return { runtimeId: record.runtimeId }
    } catch (error) {
      proc.dispose()
      throw error
    }
  }
  list() {
    return { runtimes: discoverRuntimes() }
  }
  async attach(value: unknown): Promise<RuntimeStatus> {
    const params = object(value)
    const id =
      params.runtimeId !== undefined
        ? uuid(params.runtimeId)
        : this.list().runtimes.find(r => r.mode === 'rpc' && r.sessionId === string(params.sessionId))?.runtimeId
    if (!id) throw new Error('No owned runtime for this session')
    if (this.closed || this.attaching.has(id) || this.peers.has(id))
      throw new Error('Runtime already attached or connection closing')
    if (this.peers.size + this.attaching.size >= 64) throw new Error('Runtime attachment limit reached')
    this.attaching.add(id)
    let peer: RuntimeClient | undefined
    try {
      peer = await RuntimeClient.open(id)
      const status = await peer.request<RuntimeStatus>(runtimeMethods.status)
      if (this.closed) throw new Error('ACP connection closed during attach')
      this.peers.set(id, peer)
      const current = peer
      void peer.connection.closed
        .catch(() => undefined)
        .then(() => {
          if (this.peers.get(id) === current) this.peers.delete(id)
        })
      return status
    } catch (error) {
      peer?.close()
      throw error
    } finally {
      this.attaching.delete(id)
    }
  }
  async request(method: string, value: unknown): Promise<unknown> {
    const params = object(value),
      id = uuid(params.runtimeId)
    const peer = this.peers.get(id)
    if (this.closed || !peer) throw new Error('Runtime not attached; discover and reconnect')
    if (params.generation !== peer.record.generation) throw new Error('Runtime generation mismatch')
    if (method === runtimeMethods.detach) {
      this.peers.delete(id)
      peer.close()
      return { detached: true }
    }
    return peer.request(method, params)
  }
  async disposeAndWait(timeoutMs: number) {
    this.close()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled([...this.starting]).then(() =>
          Promise.all([...this.children].map(child => child.whenTerminated()))
        ),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  close() {
    this.closed = true
    this.abort.abort()
    for (const child of this.children) child.dispose()
    for (const peer of this.peers.values()) peer.close()
    this.peers.clear()
  }
}
