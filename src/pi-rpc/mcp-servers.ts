export type McpServer =
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  | { name: string; type: 'http' | 'sse'; url: string; headers: Array<{ name: string; value: string }> }

export const MCP_COMMAND = 'pi-acp-mcp'
export const MCP_WIDGET = 'pi-acp-mcp-result'
export const MCP_REGISTER_EVENT = 'pi-mcp-adapter:runtime-register:v1'
export const MAX_MCP_REQUEST_BYTES = 1024 * 1024

export class McpConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'McpConfigurationError'
  }
}

function invalid(index: number, field: string): never {
  throw new McpConfigurationError('INVALID_MCP_SERVERS', `MCP 服务 ${index + 1} 的 ${field} 无效`)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pairs(value: unknown, index: number, field: 'env' | 'headers'): Array<{ name: string; value: string }> {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid(index, field)
  const seen = new Set<string>()
  return value.map(entry => {
    if (!record(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string') invalid(index, field)
    const name = entry.name
    const validName = field === 'env' ? /^[^=\s\0]+$/.test(name) : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
    const key = field === 'headers' ? name.toLowerCase() : name
    if (!validName || seen.has(key) || entry.value.includes('\0')) invalid(index, field)
    if (field === 'headers' && /[\r\n]/.test(entry.value)) invalid(index, field)
    seen.add(key)
    return { name, value: entry.value }
  })
}

export function parseMcpServers(value: unknown): McpServer[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new McpConfigurationError('INVALID_MCP_SERVERS', 'mcpServers 必须是数组')
  const names = new Set<string>()
  const servers = value.map((entry, index): McpServer => {
    if (!record(entry)) invalid(index, '定义')
    if (
      typeof entry.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(entry.name) ||
      ['__proto__', 'prototype', 'constructor'].includes(entry.name) ||
      names.has(entry.name)
    )
      invalid(index, 'name（必须唯一且不含空白或控制字符）')
    names.add(entry.name)
    if (entry.type === 'http' || entry.type === 'sse') {
      if (typeof entry.url !== 'string' || entry.command !== undefined) invalid(index, 'url')
      try {
        const url = new URL(entry.url)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
          invalid(index, 'url')
      } catch {
        invalid(index, 'url')
      }
      return { name: entry.name, type: entry.type, url: entry.url, headers: pairs(entry.headers, index, 'headers') }
    }
    if (entry.type !== undefined && entry.type !== 'stdio') invalid(index, 'type')
    if (
      typeof entry.command !== 'string' ||
      !entry.command.trim() ||
      entry.command.includes('\0') ||
      entry.url !== undefined
    )
      invalid(index, 'command')
    const args = entry.args ?? []
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) invalid(index, 'args')
    return { name: entry.name, command: entry.command, args: [...args], env: pairs(entry.env, index, 'env') }
  })
  if (Buffer.byteLength(JSON.stringify(servers)) > MAX_MCP_REQUEST_BYTES)
    throw new McpConfigurationError('INVALID_MCP_SERVERS', 'mcpServers 超过 1 MiB 上限')
  return servers
}

export function mcpDefinition(server: McpServer): Record<string, unknown> {
  if ('command' in server)
    return {
      command: server.command,
      args: server.args,
      env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
      literalEnv: true,
      inheritEnv: false,
      directTools: false
    }
  return {
    url: server.url,
    headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
    httpTransport: server.type === 'http' ? 'streamable-http' : 'sse',
    directTools: false
  }
}
