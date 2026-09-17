import {
  discoverRuntimes,
  object,
  RuntimeClient,
  runtimeMethods,
  string,
  uuid,
  type RuntimeStatus
} from './transport.js'

/** Connection-scoped ACP facade. It never takes ownership of an attached Pi process. */
export class RuntimeGateway {
  private peers = new Map<string, RuntimeClient>()
  private attaching = new Set<string>()
  private closed = false
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
  close() {
    this.closed = true
    for (const peer of this.peers.values()) peer.close()
    this.peers.clear()
  }
}
