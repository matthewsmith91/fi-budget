import type { AccountMapping } from '@budget-fi/core'
import { describe, expect, it } from 'vitest'
import type { ExternalAccount } from './bank.ts'
import {
  daysThisMonth,
  firstOfMonth,
  openFromBank,
  openingBalance,
  unlinkedBankAccounts,
  type OpenDeps,
} from './bank-open.ts'

const bank = (over: Partial<ExternalAccount> = {}): ExternalAccount => ({
  id: 'ext-1',
  name: 'Checking',
  org: 'Credit Union',
  currency: 'USD',
  balance: 100_000,
  balanceDate: '2026-10-30T12:00:00Z',
  transactions: [
    { id: 'a', posted: '2026-10-03', amount: -2_500, description: 'Coffee' },
    { id: 'b', posted: '2026-10-15', amount: 50_000, description: 'Pay' },
  ],
  ...over,
})

function recorder() {
  const calls: string[] = []
  const created: { date: string; amount: number }[] = []
  const deps: OpenDeps = {
    mapExternalAccount: (i) => {
      calls.push(`map ${i.externalId} -> ${i.accountId}`)
      return Promise.resolve({} as AccountMapping)
    },
    importTransactions: (accounts) => {
      calls.push(`import ${accounts[0]!.transactions.length}`)
      return Promise.resolve({
        added: 0,
        matched: 0,
        alreadyImported: 0,
        dismissed: 0,
        unmapped: [],
      })
    },
    createTransaction: (i) => {
      calls.push('start')
      created.push({ date: i.date, amount: i.amount })
      return Promise.resolve()
    },
    recordBankBalances: (b) => {
      calls.push(`value ${b[0]!.balance}`)
      return Promise.resolve(1)
    },
  }
  return { calls, created, deps }
}

describe('openingBalance', () => {
  it('is the bank balance with the fetched transactions taken back out', () => {
    // 100,000 now = start + (-2,500) + 50,000, so start = 52,500
    expect(openingBalance(bank())).toBe(52_500)
  })

  it('is the bank balance when nothing was fetched', () => {
    expect(openingBalance(bank({ transactions: [] }))).toBe(100_000)
  })

  it('handles a card that owes money', () => {
    const card = bank({
      balance: -30_000,
      transactions: [{ id: 'a', posted: '2026-10-02', amount: -12_000, description: 'Shop' }],
    })
    expect(openingBalance(card)).toBe(-18_000)
  })
})

describe('month window', () => {
  it('starts on the first and spans the days so far', () => {
    expect(firstOfMonth('2026-10-31')).toBe('2026-10-01')
    expect(daysThisMonth('2026-10-31')).toBe(31)
    expect(daysThisMonth('2026-11-01')).toBe(1)
  })
})

describe('unlinkedBankAccounts', () => {
  it('leaves out bank accounts already linked to an account', () => {
    const mappings: AccountMapping[] = [
      { externalId: 'ext-1', name: 'Checking', org: '', accountId: 'acc-1' },
      { externalId: 'ext-2', name: 'Savings', org: '', accountId: null },
    ]
    const fetched = [bank({ id: 'ext-1' }), bank({ id: 'ext-2' }), bank({ id: 'ext-3' })]
    expect(unlinkedBankAccounts(fetched, mappings).map((a) => a.id)).toEqual(['ext-2', 'ext-3'])
  })
})

describe('openFromBank', () => {
  it('links, imports the month and opens at the balance before it', async () => {
    const { calls, created, deps } = recorder()
    await openFromBank(deps, { id: 'acc-1', type: 'checking' }, bank(), '2026-10-31')
    expect(calls).toEqual(['map ext-1 -> acc-1', 'import 2', 'start'])
    expect(created).toEqual([{ date: '2026-10-01', amount: 52_500 }])
  })

  it('writes no starting balance when the transactions add up to the whole balance', async () => {
    const { calls, deps } = recorder()
    const exact = bank({ balance: 47_500 })
    await openFromBank(deps, { id: 'acc-1', type: 'savings' }, exact, '2026-10-31')
    expect(calls).toEqual(['map ext-1 -> acc-1', 'import 2'])
  })

  it('values an investment account at the bank balance and imports nothing', async () => {
    const { calls, deps } = recorder()
    await openFromBank(deps, { id: 'acc-1', type: 'investment' }, bank(), '2026-10-31')
    expect(calls).toEqual(['map ext-1 -> acc-1', 'value 100000'])
  })
})
