import { describe, expect, it } from 'vitest'
import { money, monthLabel, parseDate, shiftMonth, shortDate, todayIso } from './format.ts'

describe('format', () => {
  it('formats money', () => {
    expect(money(123456)).toBe('$1,234.56')
    expect(money(-1200)).toBe('-$12.00')
    expect(money(0)).toBe('$0.00')
  })

  it('moves between months across year boundaries', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-05', 0)).toBe('2026-05')
    expect(shiftMonth('2026-05', 24)).toBe('2028-05')
  })

  it('labels months', () => {
    expect(monthLabel('2026-10')).toEqual({ name: 'October', year: '2026' })
    expect(monthLabel('2026-01')).toEqual({ name: 'January', year: '2026' })
  })

  it('uses local calendar fields for today', () => {
    expect(todayIso(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })

  it('shows and parses dates', () => {
    expect(shortDate('2026-10-28')).toBe('10/28/2026')
    const now = new Date(2026, 5, 1)
    expect(parseDate('10/28/2026', now)).toBe('2026-10-28')
    expect(parseDate('1/5/27', now)).toBe('2027-01-05')
    expect(parseDate('3/9', now)).toBe('2026-03-09')
    expect(parseDate('2026-02-03', now)).toBe('2026-02-03')
    expect(parseDate('2/30/2026', now)).toBeNull()
    expect(parseDate('nope', now)).toBeNull()
  })
})
