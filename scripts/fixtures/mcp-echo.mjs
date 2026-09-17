import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

export function fixtureMcp(name, onCall = () => {}) {
  let extra = false
  return message => {
    const result = value => ({ jsonrpc: '2.0', id: message.id, result: value })
    if (message.id === undefined) return undefined
    if (message.method === 'initialize')
      return result({
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name, version: '1.0.0' }
      })
    if (message.method === 'ping') return result({})
    if (message.method === 'tools/list')
      return result({
        tools: (extra ? ['echo', 'extra'] : ['echo']).map(tool => ({
          name: tool,
          description: `中文验收工具 ${name}.${tool}`,
          inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }
        }))
      })
    if (message.method === 'tools/call') {
      const tool = message.params.name
      if (tool !== 'echo' && !(tool === 'extra' && extra))
        return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown fixture tool' } }
      const text = `${name}.${tool}:${message.params.arguments.message}`
      const changed = tool === 'echo' && !extra
      extra ||= changed
      onCall({ name, tool, text, changed })
      return result({ content: [{ type: 'text', text }] })
    }
    return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported fixture method' } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reply = fixtureMcp(process.env.FIXTURE_NAME ?? 'fixture', ({ changed }) => {
    if (changed)
      setTimeout(
        () =>
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n'),
        0
      )
  })
  createInterface({ input: process.stdin }).on('line', line => {
    try {
      const response = reply(JSON.parse(line))
      if (response) process.stdout.write(JSON.stringify(response) + '\n')
    } catch (error) {
      process.stderr.write(`${error.message}\n`)
    }
  })
}
