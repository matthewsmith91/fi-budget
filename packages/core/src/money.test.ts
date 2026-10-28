import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { allocate, cents, formatCents, parseCents, percentOf, sumCents } from './money.ts'

describe('cents', () => {
  it('accepts safe integers', () => {
    expect(cents(0)).toBe(0)
    expect(cents(-1250)).toBe(-1250)
  })
  it('rejects non-integers and unsafe values', () => {
    expect(() => cents(1.5)).toThrow(RangeError)
    expect(() => cents(NaN)).toThrow(RangeError)
    expect(() => cents(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError)
  })
})

describe('parseCents', () => {
  it.each([
    ['12', 1200],
    ['12.3', 1230],
    ['12.34', 1234],
    ['$1,234.50', 123450],
    ['-5.05', -505],
    ['(5.05)', -505],
    ['.99', 99],
    ['0.10', 10],
    ['  7 ', 700],
    ['19.99', 1999],
    ['1.15', 115],
  ])('parses %s', (input, expected) => {
    expect(parseCents(input)).toBe(expected)
  })
  it.each(['', 'abc', '1.234', '1,2', '--1', '1.2.3', '$', '12e3'])('rejects %j', (input) => {
    expect(parseCents(input)).toBeNull()
  })
  it('round-trips with formatCents without drift', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000_000_00, max: 1_000_000_000_00 }), (n) => {
        expect(parseCents(formatCents(cents(n)))).toBe(n)
      }),
    )
  })
})

describe('formatCents', () => {
  it('formats USD', () => {
    expect(formatCents(cents(123456))).toBe('$1,234.56')
    expect(formatCents(cents(5))).toBe('$0.05')
    expect(formatCents(cents(-505))).toBe('-$5.05')
    expect(formatCents(cents(0))).toBe('$0.00')
  })
  it('omits the symbol on request', () => {
    expect(formatCents(cents(123456), { symbol: false })).toBe('1,234.56')
  })
})

describe('sumCents', () => {
  it('sums exactly where floats would not', () => {
    expect(sumCents([cents(10), cents(20)])).toBe(30)
    expect(sumCents([])).toBe(0)
  })
})

describe('percentOf', () => {
  it('rounds half away from zero to the cent and reports the remainder', () => {
    expect(percentOf(cents(100000), 10)).toEqual({ amount: 10000, remainder: 90000 })
    expect(percentOf(cents(1005), 10)).toEqual({ amount: 101, remainder: 904 })
    expect(percentOf(cents(-1005), 10)).toEqual({ amount: -101, remainder: -904 })
  })
  it('amount + remainder always equals the total', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        fc.integer({ min: 0, max: 100 }),
        (total, pct) => {
          const { amount, remainder } = percentOf(cents(total), pct)
          expect(amount + remainder).toBe(total)
        },
      ),
    )
  })
  it('rejects percents outside 0-100', () => {
    expect(() => percentOf(cents(100), 101)).toThrow(RangeError)
    expect(() => percentOf(cents(100), -1)).toThrow(RangeError)
  })
})

describe('allocate', () => {
  it('splits by weight with largest remainder', () => {
    expect(allocate(cents(100), [1, 1, 1])).toEqual([34, 33, 33])
    expect(allocate(cents(10), [1, 1, 1])).toEqual([4, 3, 3])
    expect(allocate(cents(100), [70, 30])).toEqual([70, 30])
  })
  it('handles negative totals symmetrically', () => {
    expect(allocate(cents(-100), [1, 1, 1])).toEqual([-34, -33, -33])
  })
  it('always sums to the total', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          const parts = allocate(cents(total), weights)
          expect(parts).toHaveLength(weights.length)
          expect(sumCents(parts)).toBe(total)
        },
      ),
    )
  })
  it('rejects empty or non-positive weights', () => {
    expect(() => allocate(cents(100), [])).toThrow(RangeError)
    expect(() => allocate(cents(100), [0, 0])).toThrow(RangeError)
    expect(() => allocate(cents(100), [-1, 2])).toThrow(RangeError)
  })
})
