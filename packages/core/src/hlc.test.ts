import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  ClockError,
  formatHlc,
  isDeviceId,
  MAX_COUNTER,
  MAX_DRIFT_MS,
  newDeviceId,
  nextHlc,
  parseHlc,
  receiveHlc,
} from './hlc.ts'

const A = '0123456789abcdef'
const B = 'fedcba9876543210'
const T = Date.parse('2026-01-01T00:00:00.000Z')

describe('hlc', () => {
  it('formats and parses', () => {
    const text = formatHlc({ ms: T, counter: 255, node: A })
    expect(text).toBe('2026-01-01T00:00:00.000Z-00FF-0123456789abcdef')
    expect(parseHlc(text)).toEqual({ ms: T, counter: 255, node: A })
  })

  it('rejects malformed timestamps and device ids', () => {
    expect(() => parseHlc('nope')).toThrow(ClockError)
    expect(() => parseHlc('2026-01-01T00:00:00.000Z-00ff-0123456789abcdef')).toThrow(ClockError)
    expect(() => formatHlc({ ms: T, counter: 0, node: 'short' })).toThrow(ClockError)
    expect(() => formatHlc({ ms: NaN, counter: 0, node: A })).toThrow(ClockError)
  })

  it('mints valid device ids', () => {
    const id = newDeviceId()
    expect(isDeviceId(id)).toBe(true)
    expect(newDeviceId()).not.toBe(id)
  })

  it('send: resets the counter when the wall clock moves on, bumps it when it has not', () => {
    const first = nextHlc(null, T, A)
    expect(first).toEqual({ ms: T, counter: 0, node: A })
    expect(nextHlc(first, T, A)).toEqual({ ms: T, counter: 1, node: A })
    expect(nextHlc(first, T + 1, A)).toEqual({ ms: T + 1, counter: 0, node: A })
  })

  it('send: never goes backwards when the wall clock does', () => {
    const later = nextHlc({ ms: T + 5000, counter: 3, node: A }, T, A)
    expect(later).toEqual({ ms: T + 5000, counter: 4, node: A })
  })

  it('send: refuses to overflow the counter', () => {
    expect(() => nextHlc({ ms: T, counter: MAX_COUNTER, node: A }, T, A)).toThrow(ClockError)
  })

  it('receive: lands after both the local and the remote timestamp', () => {
    const local = { ms: T, counter: 2, node: A }
    expect(receiveHlc(local, { ms: T, counter: 7, node: B }, T)).toEqual({
      ms: T,
      counter: 8,
      node: A,
    })
    expect(receiveHlc(local, { ms: T + 1000, counter: 4, node: B }, T)).toEqual({
      ms: T + 1000,
      counter: 5,
      node: A,
    })
    expect(receiveHlc(local, { ms: T - 1000, counter: 4, node: B }, T + 10)).toEqual({
      ms: T + 10,
      counter: 0,
      node: A,
    })
  })

  it('receive: refuses a timestamp from too far in the future', () => {
    const remote = { ms: T + MAX_DRIFT_MS + 1, counter: 0, node: B }
    expect(() => receiveHlc({ ms: T, counter: 0, node: A }, remote, T)).toThrow(/too far ahead/)
    const ok = { ms: T + MAX_DRIFT_MS, counter: 0, node: B }
    expect(receiveHlc({ ms: T, counter: 0, node: A }, ok, T).ms).toBe(T + MAX_DRIFT_MS)
  })

  it('string order is time order (property)', () => {
    const hlc = fc.record({
      ms: fc.integer({ min: Date.parse('2000-01-01'), max: Date.parse('2100-01-01') }),
      counter: fc.integer({ min: 0, max: MAX_COUNTER }),
      node: fc.constantFrom(A, B),
    })
    fc.assert(
      fc.property(hlc, hlc, (x, y) => {
        const byFields = x.ms - y.ms || x.counter - y.counter || x.node.localeCompare(y.node)
        const byString = formatHlc(x).localeCompare(formatHlc(y))
        expect(Math.sign(byString)).toBe(Math.sign(byFields))
      }),
    )
  })
})
