import { describe, expect, it } from 'vitest'
import { diffTries, emptyTrie, insertTimestamp, isTrie, timestampKey } from './merkle.ts'

// The same vector is asserted in apps/api/src/merkle.test.ts: the devices and the server
// must compute identical hashes or every sync would look like a divergence.
const VECTOR = [
  '2026-01-01T00:00:00.000Z-0000-0123456789abcdef',
  '2026-01-01T00:00:30.000Z-0001-0123456789abcdef',
  '2026-03-15T12:34:56.789Z-0000-fedcba9876543210',
]

const build = (timestamps: string[]) => {
  const trie = emptyTrie()
  for (const t of timestamps) insertTimestamp(trie, t)
  return trie
}

const at = (iso: string, n = 0) => `${iso}-${n.toString(16).padStart(4, '0')}-0123456789abcdef`

describe('merkle trie', () => {
  it('hashes the shared test vector to the same root as the server', () => {
    expect(build(VECTOR).hash).toBe(1528213123)
    expect(VECTOR.map(timestampKey)).toEqual([
      '00002001102101222000',
      '00002001102101222000',
      '00002001121210012021',
    ])
  })

  it('does not depend on insertion order', () => {
    expect(build(VECTOR)).toEqual(build([...VECTOR].reverse()))
  })

  it('has no difference between identical sets', () => {
    expect(diffTries(build(VECTOR), build(VECTOR))).toBeNull()
    expect(diffTries(emptyTrie(), emptyTrie())).toBeNull()
  })

  it('finds the minute of a message one side lacks', () => {
    const extra = at('2026-02-10T08:15:42.000Z')
    const minute = Date.parse('2026-02-10T08:15:00.000Z')
    expect(diffTries(build(VECTOR), build([...VECTOR, extra]))).toBe(minute)
    expect(diffTries(build([...VECTOR, extra]), build(VECTOR))).toBe(minute)
  })

  it('reports the earliest of several differences', () => {
    const early = at('2026-01-20T00:00:10.000Z')
    const late = at('2026-06-01T00:00:10.000Z')
    expect(diffTries(build(VECTOR), build([...VECTOR, late, early]))).toBe(
      Date.parse('2026-01-20T00:00:00.000Z'),
    )
  })

  it('separates messages in the same minute only by the hash, not the position', () => {
    const a = at('2026-02-10T08:15:01.000Z')
    const b = at('2026-02-10T08:15:02.000Z')
    expect(diffTries(build([a]), build([b]))).toBe(Date.parse('2026-02-10T08:15:00.000Z'))
  })

  it('recognises a trie and rejects other shapes', () => {
    expect(isTrie(JSON.parse(JSON.stringify(build(VECTOR))))).toBe(true)
    expect(isTrie(null)).toBe(false)
    expect(isTrie({ hash: 'x' })).toBe(false)
    expect(isTrie({ hash: 1, 0: { hash: 'x' } })).toBe(false)
  })
})
