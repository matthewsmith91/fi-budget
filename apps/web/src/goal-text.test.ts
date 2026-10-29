import type { Goal, GoalBalance } from '@budget-fi/core'
import { describe, expect, it } from 'vitest'
import { goalStatus, holdingWarning, targetLabel } from './goal-text.ts'

const goal: Goal = {
  id: 'g',
  categoryId: 'c',
  name: 'Laptop',
  targetAmount: 120_000,
  targetDate: '2027-03-15',
  archived: false,
  heldInAccountId: null,
}
const balance = (over: Partial<GoalBalance>): GoalBalance => ({
  goalId: 'g',
  categoryId: 'c',
  assigned: 0,
  activity: 0,
  available: 0,
  percentFunded: 0,
  monthlyNeeded: 20_000,
  underfunded: 20_000,
  ...over,
})

describe('goalStatus', () => {
  it('shows progress, the monthly amount and what is still due', () => {
    expect(goalStatus(goal, balance({}))).toEqual([
      '0% of $1,200.00',
      '$200.00/mo for Mar 2027',
      '$200.00 more to assign',
    ])
  })

  it('drops the still-due line once this month is covered', () => {
    expect(goalStatus(goal, balance({ percentFunded: 16, underfunded: 0 }))).toEqual([
      '16% of $1,200.00',
      '$200.00/mo for Mar 2027',
    ])
  })

  it('says so when a goal is funded, and skips the monthly line without a date', () => {
    expect(
      goalStatus(goal, balance({ percentFunded: 100, monthlyNeeded: 0, underfunded: 0 })),
    ).toEqual(['100% of $1,200.00', 'Fully funded'])
    expect(
      goalStatus(
        { ...goal, targetDate: null },
        balance({ percentFunded: 40, monthlyNeeded: null }),
      ),
    ).toEqual(['40% of $1,200.00'])
  })

  it('copes with a goal whose balances have not loaded', () => {
    expect(goalStatus(goal, undefined)).toEqual(['0% of $1,200.00'])
  })
})

describe('targetLabel', () => {
  it('names the month without shifting time zones', () => {
    expect(targetLabel('2027-03-01')).toBe('Mar 2027')
    expect(targetLabel('2026-12-31')).toBe('Dec 2026')
  })
})

describe('held in', () => {
  it('names the account a goal is held in', () => {
    expect(goalStatus(goal, balance({}), 'Ally HYSA')).toContain('Held in Ally HYSA')
    expect(goalStatus(goal, balance({}))).not.toContainEqual(expect.stringContaining('Held in'))
  })

  it('warns only when the goals held in an account add up to more than it has', () => {
    const holding = { accountId: 'a', balance: 50_000, held: 60_000, over: 10_000, goals: [] }
    expect(holdingWarning(holding, 'Ally HYSA')).toBe(
      'Ally HYSA has $500.00, but the goals held in it add up to $600.00. $100.00 of that money isn’t there.',
    )
    expect(holdingWarning({ ...holding, held: 40_000, over: 0 }, 'Ally HYSA')).toBeNull()
  })
})
