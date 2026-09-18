import test from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeEvents, resultText } from '../../src/runtime/events.js'

test('runtime event ring: bounded count/bytes, cursor gaps, no token/image/thought projection', () => {
  const events = new RuntimeEvents()
  for (let i = 0; i < 900; i++) events.append({ kind: 'message', text: '中文'.repeat(9000) })
  const page = events.page({ after: 0, limit: 100 })
  assert(page.gap)
  assert(page.items[0]!.seq > 1)
  assert(Buffer.byteLength(JSON.stringify(page)) < 68000)
  assert(page.items.every(item => item.text!.length === 8192 && item.truncated))
  let cursor = page.nextAfter,
    count = page.items.length
  while (cursor < 900) {
    const next = events.page({ after: cursor })
    assert(!next.gap)
    assert(next.nextAfter > cursor)
    cursor = next.nextAfter
    count += next.items.length
  }
  assert(count <= 512)
  assert(!events.page({ after: cursor }).hasMore)
  for (const broken of [{ after: -1 }, { after: 901 }, { after: '1' }, { limit: 101 }, { limit: 0 }])
    assert.throws(() => events.page(broken))
  assert.equal(
    resultText({
      content: [
        { type: 'text', text: 'real' },
        { type: 'thinking', text: 'hidden' },
        { type: 'image', data: 'bytes' }
      ],
      details: 'secret'
    }),
    'real'
  )
})
