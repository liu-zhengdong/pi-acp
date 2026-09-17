import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionRepository } from '../../src/acp/session-repository.js'
import { SessionStore } from '../../src/acp/session-store.js'

test('explicit history import validates identity/cwd, refuses collisions, and never rewrites history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-import-'))
  const repository = new SessionRepository(new SessionStore(join(root, 'map.json')))
  const file = join(root, 'legacy.jsonl'),
    other = join(root, 'other.jsonl')
  const header = { type: 'session', id: randomUUID(), cwd: root }
  const original = JSON.stringify(header) + '\n' + JSON.stringify({ type: 'message', marker: 'preserve' }) + '\n'
  writeFileSync(file, original)
  assert.equal((await repository.importFile(root, file)).sessionId, header.id)
  assert.equal(readFileSync(file, 'utf8'), original)
  assert.equal((await repository.importFile(root, file)).sessionId, header.id)
  writeFileSync(other, original)
  await assert.rejects(repository.importFile(root, other), /already mapped/)
  await assert.rejects(repository.importFile('/different-cwd', file), /cwd mismatch/)
  await assert.rejects(repository.importFile(root, 'relative.jsonl'), /absolute/)
  for (const broken of [
    '{}',
    '{',
    JSON.stringify({ ...header, type: 'other' }),
    JSON.stringify({ ...header, id: '-'.repeat(36) }),
    JSON.stringify({ ...header, cwd: '/elsewhere' }),
    'x'.repeat(1024 * 1024 + 1)
  ]) {
    writeFileSync(other, broken)
    await assert.rejects(repository.importFile(root, other))
    assert.equal(readFileSync(other, 'utf8'), broken)
  }
  assert.equal(readFileSync(file, 'utf8'), original)
})
