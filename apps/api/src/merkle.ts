/**
 * The server's half of the timestamp Merkle trie. This mirrors packages/core/src/merkle.ts
 * (the server cannot import the browser-facing core package), and the two must hash
 * identically: both test suites assert the same fixed root hash.
 */
export interface TrieNode {
  hash: number
  0?: TrieNode
  1?: TrieNode
  2?: TrieNode
}

/** Base-3 digits of minutes since the epoch, padded so no key is a prefix of another. */
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

export function timestampKey(timestamp: string): string {
  return Math.floor(Date.parse(timestamp.slice(0, 24)) / MINUTE_MS)
    .toString(3)
    .padStart(KEY_LENGTH, '0')
}

/** Adds a timestamp in place. XOR cancels itself, so each timestamp may be inserted only once. */
export function insertTimestamp(trie: TrieNode, timestamp: string): TrieNode {
  const hash = hashTimestamp(timestamp)
  trie.hash = (trie.hash ^ hash) >>> 0
  let node = trie
  for (const ch of timestampKey(timestamp)) {
    const digit = Number(ch) as 0 | 1 | 2
    node = node[digit] ??= emptyTrie()
    node.hash = (node.hash ^ hash) >>> 0
  }
  return trie
}
