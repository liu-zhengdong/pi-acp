import { object } from './transport.js'

export const EVENTS_CAPABILITY = 'pi-acp/runtime-events/v1'
export type RuntimeEvent = {
  seq: number
  at: number
  kind: 'session' | 'run_start' | 'run_end' | 'tool_start' | 'tool_end' | 'message' | 'delivery'
  name?: string
  callId?: string
  text?: string
  error?: boolean
  truncated?: boolean
}

/** No tokens, thoughts, images or credentials from the controller. Bounded per generation. */
export class RuntimeEvents {
  private rows: RuntimeEvent[] = []
  private sequence = 0
  private bytes = 0
  append(value: Omit<RuntimeEvent, 'seq' | 'at'>) {
    const row: RuntimeEvent = { ...value, seq: ++this.sequence, at: Date.now() }
    if (row.text && row.text.length > 8192) {
      row.text = row.text.slice(0, 8192)
      row.truncated = true
    }
    this.rows.push(row)
    this.bytes += Buffer.byteLength(JSON.stringify(row))
    while (this.rows.length > 512 || this.bytes > 1_048_576) {
      this.bytes -= Buffer.byteLength(JSON.stringify(this.rows.shift()!))
    }
  }
  page(value: unknown) {
    const params = object(value),
      after = params.after ?? 0,
      limit = params.limit ?? 50
    if (!Number.isSafeInteger(after) || Number(after) < 0 || Number(after) > this.sequence)
      throw new Error('Invalid event cursor')
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error('Invalid event limit')
    const oldest = this.rows[0]?.seq ?? this.sequence + 1
    const items: RuntimeEvent[] = []
    let bytes = 0
    for (const row of this.rows) {
      if (row.seq <= Number(after)) continue
      const size = Buffer.byteLength(JSON.stringify(row))
      if (items.length && (items.length >= Number(limit) || bytes + size > 65536)) break
      items.push(row)
      bytes += size
    }
    const nextAfter = items.at(-1)?.seq ?? Number(after)
    return { items, nextAfter, hasMore: nextAfter < this.sequence, gap: Number(after) < oldest - 1 }
  }
}

/** Only textual tool output; do not clone tool details or embedded media. */
export function resultText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text as string)
    .join('\n')
}
