import { describe, expect, it } from 'vitest'
import { defaultChoice, guessAccount, toChoice } from './ynab-choices.ts'

const account = (name: string, match: Parameters<typeof defaultChoice>[0]['match'] = null) => ({
  name,
  transactions: 1,
  balance: 0,
  first: '2026-01-01',
  last: '2026-01-02',
  match,
})

describe('guessAccount', () => {
  it('reads the kind of account from its name', () => {
    expect(guessAccount('Chase Visa')).toEqual({ type: 'credit', onBudget: true })
    expect(guessAccount('Roth IRA')).toEqual({ type: 'investment', onBudget: false })
    expect(guessAccount('Ally HYSA')).toEqual({ type: 'savings', onBudget: true })
    expect(guessAccount('Joint Checking')).toEqual({ type: 'checking', onBudget: true })
  })
})

describe('defaultChoice', () => {
  it('uses the account that already has the name, unless it is closed', () => {
    const open = { accountId: 'a1', closed: false, hasTransactions: false }
    expect(defaultChoice(account('Checking', open))).toMatchObject({
      mode: 'existing',
      accountId: 'a1',
    })
    expect(defaultChoice(account('Checking', { ...open, closed: true })).mode).toBe('create')
    expect(defaultChoice(account('Checking')).mode).toBe('create')
  })
})

describe('toChoice', () => {
  it('needs an account when using an existing one, and never puts an investment account on budget', () => {
    expect(
      toChoice({ mode: 'existing', accountId: '', type: 'checking', onBudget: true }),
    ).toBeNull()
    expect(
      toChoice({ mode: 'existing', accountId: 'a1', type: 'checking', onBudget: true }),
    ).toEqual({
      accountId: 'a1',
    })
    expect(toChoice({ mode: 'create', accountId: '', type: 'investment', onBudget: true })).toEqual(
      {
        create: { type: 'investment', onBudget: false },
      },
    )
  })
})
