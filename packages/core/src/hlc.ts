/**
 * Hybrid logical clock. A timestamp is wall-clock milliseconds plus a counter that
 * breaks ties, plus the id of the device that minted it, so two devices never produce
 * the same timestamp. The string form sorts lexicographically in time order, which
 * lets SQLite and the sync server compare timestamps with a plain `ORDER BY`.
 *
 *   2026-01-01T00:00:00.000Z-0000-0123456789abcdef
 */
export interface Hlc {
  ms: number
  counter: number
  node: string
}

export const MAX_COUNTER = 0xffff
/** How far ahead of our own clock a remote timestamp may be before we refuse it. */
export const MAX_DRIFT_MS = 5 * 60 * 1000

const HLC_PATTERN = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)-([0-9A-F]{4})-([0-9a-f]{16})$/
const NODE_PATTERN = /^[0-9a-f]{16}$/

export class ClockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClockError'
  }
}

/** A fresh random device id: 16 lowercase hex characters, safe to embed in a timestamp. */
export function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const isDeviceId = (value: string) => NODE_PATTERN.test(value)

export function formatHlc({ ms, counter, node }: Hlc): string {
  if (!Number.isFinite(ms)) throw new ClockError('The clock produced an invalid time')
  if (!NODE_PATTERN.test(node)) throw new ClockError(`Invalid device id "${node}"`)
  const iso = new Date(ms).toISOString()
  return `${iso}-${counter.toString(16).toUpperCase().padStart(4, '0')}-${node}`
}

export function parseHlc(text: string): Hlc {
  const m = HLC_PATTERN.exec(text)
  if (!m) throw new ClockError(`Malformed timestamp "${text}"`)
  return { ms: Date.parse(m[1]!), counter: parseInt(m[2]!, 16), node: m[3]! }
}

/** The timestamp for a local write, given the newest timestamp this device has seen. */
export function nextHlc(last: Hlc | null, wallMs: number, node: string): Hlc {
  if (!Number.isFinite(wallMs)) throw new ClockError('The clock produced an invalid time')
  // The wall clock may run backwards (manual change, NTP step); never let timestamps follow it.
  const ms = Math.max(wallMs, last?.ms ?? 0)
  const counter = last && ms === last.ms ? last.counter + 1 : 0
  if (counter > MAX_COUNTER) throw new ClockError('Too many changes in one millisecond')
  return { ms, counter, node }
}

/** Merges a timestamp from another device into ours so later local writes sort after it. */
export function receiveHlc(local: Hlc, remote: Hlc, wallMs: number): Hlc {
  const ms = Math.max(local.ms, remote.ms, wallMs)
  if (ms - wallMs > MAX_DRIFT_MS) {
    throw new ClockError('A timestamp from another device is too far ahead of this clock')
  }
  let counter = 0
  if (ms === local.ms && ms === remote.ms) counter = Math.max(local.counter, remote.counter) + 1
  else if (ms === local.ms) counter = local.counter + 1
  else if (ms === remote.ms) counter = remote.counter + 1
  if (counter > MAX_COUNTER) throw new ClockError('Too many changes in one millisecond')
  return { ms, counter, node: local.node }
}
