import { describe, expect, it } from 'vitest'
import { describeIncomeRule } from './income-rule-text.ts'

const names = { account: null, target: 'Tithe', money: (n: number) => `$${n / 100}` }

describe('describeIncomeRule', () => {
  it('says what is matched, what is given and where it goes', () => {
    expect(
      describeIncomeRule(
        { match: 'Acme Payroll', percent: 10, fixedAmount: null, basis: 'gross' },
        { ...names, account: 'Checking' },
      ),
    ).toBe('“Acme Payroll” in Checking → 10% of gross pay → Tithe')
  })

  it('names a fixed amount and an account-only match', () => {
    expect(
      describeIncomeRule(
        { match: null, percent: null, fixedAmount: 5000, basis: 'net' },
        { ...names, account: 'Checking' },
      ),
    ).toBe('in Checking → $50 → Tithe')
  })
})
