import { describe, expect, it } from 'vitest'
import { niceAxis, spreadIndexes } from './chart-scale.ts'

describe('niceAxis', () => {
  it('rounds the range out to a clean step', () => {
    expect(niceAxis(0, 97)).toEqual({ min: 0, max: 100, ticks: [0, 25, 50, 75, 100] })
  })

  it('covers negatives and keeps the ticks evenly spaced', () => {
    const axis = niceAxis(-30, 120)
    expect(axis.min).toBeLessThanOrEqual(-30)
    expect(axis.max).toBeGreaterThanOrEqual(120)
    const gaps = axis.ticks.slice(1).map((t, i) => t - axis.ticks[i]!)
    expect(new Set(gaps).size).toBe(1)
    expect(axis.ticks).toContain(0)
  })

  it('gives a flat series some room', () => {
    const axis = niceAxis(500, 500)
    expect(axis.min).toBeLessThan(500)
    expect(axis.max).toBeGreaterThan(500)
  })

  it('handles a flat zero series', () => {
    const axis = niceAxis(0, 0)
    expect(axis.min).toBeLessThan(0)
    expect(axis.max).toBeGreaterThan(0)
  })
})

describe('spreadIndexes', () => {
  it('spaces labels evenly back from the last point', () => {
    expect(spreadIndexes(13, 4)).toEqual([0, 4, 8, 12])
    expect(spreadIndexes(12, 7)).toEqual([1, 3, 5, 7, 9, 11])
    expect(spreadIndexes(12, 1)).toEqual([11])
    expect(spreadIndexes(3, 5)).toEqual([0, 1, 2])
    expect(spreadIndexes(0, 5)).toEqual([])
    expect(spreadIndexes(1, 5)).toEqual([0])
  })
})
