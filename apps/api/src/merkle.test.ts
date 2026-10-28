import { describe, expect, it } from 'vitest'
import { emptyTrie, insertTimestamp, timestampKey } from './merkle.ts'

// The same vector is asserted in packages/core/src/merkle.test.ts: the server and the
// devices must compute identical hashes or every sync would look like a divergence.
const VECTOR = [
  '2026-01-01T00:00:00.000Z-0000-0123456789abcdef',
  '2026-01-01T00:00:30.000Z-0001-0123456789abcdef',
  '2026-03-15T12:34:56.789Z-0000-fedcba9876543210',
]

describe('server merkle trie', () => {
  it('hashes the shared test vector to the same root as the devices', () => {
    const trie = emptyTrie()
    for (const t of VECTOR) insertTimestamp(trie, t)
    expect(trie.hash).toBe(1528213123)
    expect(VECTOR.map(timestampKey)).toEqual([
      '00002001102101222000',
      '00002001102101222000',
      '00002001121210012021',
    ])
  })

  it('does not depend on insertion order', () => {
    const a = emptyTrie()
    const b = emptyTrie()
    for (const t of VECTOR) insertTimestamp(a, t)
    for (const t of [...VECTOR].reverse()) insertTimestamp(b, t)
    expect(a).toEqual(b)
  })
})
