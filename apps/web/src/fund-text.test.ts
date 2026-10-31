import type { EmergencyFund } from '@budget-fi/core'
import { describe, expect, it } from 'vitest'
import { fundPercent, fundStatus, refillText } from './fund-text.ts'

const fund = (over: Partial<EmergencyFund>): EmergencyFund => ({
  settings: { categoryId: 'c', months: 6, window: 12 },
  balance: 0,
  averageNeed: 200_000,
  averagedMonths: 12,
  target: 1_200_000,
  shortfall: 1_200_000,
  monthsCovered: 0,
  ...over,
})

describe('fundPercent', () => {
  it('rounds down and stays between 0 and 100', () => {
    expect(fundPercent(fund({ balance: 599_999 }))).toBe(49)
    expect(fundPercent(fund({ balance: 5_000_000 }))).toBe(100)
    expect(fundPercent(fund({ balance: -50_000 }))).toBe(0)
  })
  it('is 0 without a target', () => {
    expect(fundPercent(fund({ target: 0, balance: 10 }))).toBe(0)
  })
})

describe('fundStatus', () => {
  it('shows months covered and what is left', () => {
    expect(fundStatus(fund({ balance: 450_000, monthsCovered: 2.2, shortfall: 750_000 }))).toEqual([
      'Covers 2.2 of 6 months',
      '$7,500.00 to go',
    ])
  })
  it('says the target is met', () => {
    expect(fundStatus(fund({ monthsCovered: 6.5, shortfall: 0 }))[1]).toBe('Target met')
  })
  it('explains the missing target', () => {
    expect(fundStatus(fund({ target: 0, monthsCovered: null }))).toEqual([
      'No Need spending to size a target yet',
    ])
  })
})

describe('refillText', () => {
  it('says how long the fund took, or that it hasn’t yet', () => {
    expect(refillText({ balanceAfter: 100, refilledIn: 3 })).toBe('3 months')
    expect(refillText({ balanceAfter: 100, refilledIn: 1 })).toBe('1 month')
    expect(refillText({ balanceAfter: 100, refilledIn: 0 })).toBe('Right away')
    expect(refillText({ balanceAfter: 100, refilledIn: null })).toBe('Not yet')
  })
  it('has nothing to say once the fund is gone', () => {
    expect(refillText({ balanceAfter: null, refilledIn: null })).toBe('—')
  })
})
