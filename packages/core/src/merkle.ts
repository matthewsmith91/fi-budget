/**
 * A Merkle trie over message timestamps, keyed by the minute each one was minted. Two
 * devices (or a device and the server) with the same set of messages have the same root
 * hash; when the roots differ, walking down both tries finds the earliest minute where
 * they disagree, and everything from there on is exchanged.
 *
 * The server keeps its own copy of the build half of this file (apps/api/src/merkle.ts)
 * because it cannot import the browser-facing core package. The two must hash identically;
 * both test suites assert the same fixed root hash.
 */
export interface TrieNode {
  /** XOR of the hashes of every timestamp under this node. */
  hash: number
  0?: TrieNode
  1?: TrieNode
  2?: TrieNode
}

type Digit = 0 | 1 | 2
const DIGITS: readonly Digit[] = [0, 1, 2]
/** Base-3 digits of minutes since the epoch; fixed width so no key is a prefix of another. */
const KEY_LENGTH = 20
const MINUTE_MS = 60_000

export const emptyTrie = (): TrieNode => ({ hash: 0 })

/** 32-bit FNV-1a over the timestamp's characters (they are all ASCII). */
export function hashTimestamp(timestamp: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < timestamp.length; i++) {
    h = Math.imul(h ^ timestamp.charCodeAt(i), 0x01000193)
  }
  return h >>> 0
}

/** The trie path for a timestamp: its minute in base 3. */
export function timestampKey(timestamp: string): string {
  const ms = Date.parse(timestamp.slice(0, 24))
  if (!Number.isFinite(ms)) throw new Error(`Malformed timestamp "${timestamp}"`)
  return Math.floor(ms / MINUTE_MS)
    .toString(3)
    .padStart(KEY_LENGTH, '0')
}

/**
 * Adds a timestamp to the trie in place. XOR cancels itself, so a timestamp must be
 * inserted exactly once; callers only insert messages they have just stored.
 */
export function insertTimestamp(trie: TrieNode, timestamp: string): TrieNode {
  const hash = hashTimestamp(timestamp)
  trie.hash = (trie.hash ^ hash) >>> 0
  let node = trie
  for (const ch of timestampKey(timestamp)) {
    const digit = Number(ch) as Digit
    node = node[digit] ??= emptyTrie()
    node.hash = (node.hash ^ hash) >>> 0
  }
  return trie
}

/**
 * The start (epoch ms) of the earliest minute in which the two tries differ, or null if
 * they are identical. Messages from that minute on are the ones to exchange.
 */
export function diffTries(a: TrieNode, b: TrieNode): number | null {
  if (a.hash === b.hash) return null
  let key = ''
  let left = a
  let right = b
  for (;;) {
    const next = DIGITS.find((d) => (left[d]?.hash ?? 0) !== (right[d]?.hash ?? 0))
    if (next === undefined) break
    key += next
    left = left[next] ?? emptyTrie()
    right = right[next] ?? emptyTrie()
  }
  return parseInt(key.padEnd(KEY_LENGTH, '0'), 3) * MINUTE_MS
}

/** Checks that a value received from a server looks like a trie before it is walked. */
export function isTrie(value: unknown, depth = 0): value is TrieNode {
  if (typeof value !== 'object' || value === null || depth > KEY_LENGTH) return false
  const node = value as Record<string, unknown>
  if (typeof node.hash !== 'number') return false
  return DIGITS.every((d) => node[d] === undefined || isTrie(node[d], depth + 1))
}
