import type { CategoryRemoval } from '@budget-fi/core'
import { describe, expect, it } from 'vitest'
import { removalLines } from './category-text.ts'

const plan = (over: Partial<CategoryRemoval>): CategoryRemoval => ({
  outcome: 'deleted',
  returned: 0,
  goals: 0,
  rules: 0,
  emergencyFund: false,
  blocked: null,
  ...over,
})

describe('removalLines', () => {
  it('says an unused category is deleted, and nothing else', () => {
    expect(removalLines(plan({}), 'Spare', 'October 2026')).toEqual([
      'Spare has never been used, so it will be deleted.',
    ])
  })

  it('says a used one is hidden, where its money goes and how to get it back', () => {
    expect(
      removalLines(plan({ outcome: 'hidden', returned: 18_000 }), 'Food', 'October 2026'),
    ).toEqual([
      'Food has history, so it will be hidden, not deleted. Past transactions keep it.',
      '$180.00 goes back to Ready to Assign for October 2026.',
      'Show hidden categories to bring it back.',
    ])
  })

  it('counts goals, rules and the emergency fund', () => {
    const lines = removalLines(
      plan({ outcome: 'hidden', goals: 1, rules: 2, emergencyFund: true }),
      'Food',
      'October 2026',
    )
    expect(lines).toContain('1 goal will be archived.')
    expect(lines).toContain('2 payee and income rules will be deleted.')
    expect(lines).toContain('It will stop being your emergency fund.')
  })

  it('says goals of an unused category are deleted', () => {
    expect(removalLines(plan({ goals: 2 }), 'Spare', 'October 2026')).toContain(
      '2 goals will be deleted.',
    )
  })
})
