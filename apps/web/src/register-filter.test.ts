import type { Transaction } from '@budget-fi/core'
import { describe, expect, it } from 'vitest'
import {
  categoryTotal,
  isFiltered,
  filterHref,
  matchesFilter,
  monthFilter,
  NO_FILTER,
  parseFilter,
  searchText,
} from './register-filter.ts'

function txn(date: string, accountId: string, lines: [string | null, number][]): Transaction {
  return {
    id: `${date}${accountId}`,
    accountId,
    date,
    splits: lines.map(([categoryId, amount]) => ({ categoryId, amount })),
  } as unknown as Transaction
}

describe('register filter', () => {
  it('round-trips through the hash and drops empty parts', () => {
    const filter = {
      categoryId: 'a&b',
      accountId: null,
      from: '2026-10-01',
      to: '2026-10-31',
      query: 'trader joe',
    }
    expect(parseFilter(filterHref(filter).split('?')[1]!)).toEqual(filter)
    expect(filterHref(NO_FILTER)).toBe('#/accounts')
  })

  it('ignores malformed dates', () => {
    expect(parseFilter('from=October&to=2026-10-99x')).toEqual(NO_FILTER)
  })

  it('covers a whole month, leap February included', () => {
    expect(monthFilter('c', '2026-10')).toMatchObject({ from: '2026-10-01', to: '2026-10-31' })
    expect(monthFilter('c', '2028-02').to).toBe('2028-02-29')
    expect(monthFilter('c', '2026-02').to).toBe('2026-02-28')
  })

  it('matches on account, inclusive dates and any line in the category', () => {
    const split = txn('2026-10-15', 'x', [
      ['food', -500],
      ['gas', -300],
    ])
    expect(matchesFilter(split, { ...NO_FILTER, categoryId: 'gas' })).toBe(true)
    expect(matchesFilter(split, { ...NO_FILTER, categoryId: 'rent' })).toBe(false)
    expect(matchesFilter(split, { ...NO_FILTER, accountId: 'y' })).toBe(false)
    expect(matchesFilter(split, { ...NO_FILTER, from: '2026-10-15', to: '2026-10-15' })).toBe(true)
    expect(matchesFilter(split, { ...NO_FILTER, from: '2026-10-16' })).toBe(false)
    expect(matchesFilter(split, { ...NO_FILTER, to: '2026-10-14' })).toBe(false)
  })

  it('totals only the lines in the category', () => {
    const list = [
      txn('2026-10-01', 'x', [
        ['food', -500],
        ['gas', -300],
      ]),
      txn('2026-10-02', 'x', [['food', 200]]),
    ]
    expect(categoryTotal(list, 'food')).toBe(-300)
  })

  it('searches every word in the shown text and the amount', () => {
    const t = {
      ...txn('2026-10-15', 'x', [['food', -123450]]),
      payee: 'Trader Joe’s',
      amount: -123450,
    }
    const text = searchText(['Trader Joe’s', 'Groceries', 'Checking'], t.amount)
    const q = (query: string) => matchesFilter(t, { ...NO_FILTER, query }, text)
    expect(q('trader groceries')).toBe(true)
    expect(q('JOE')).toBe(true)
    expect(q('1,234.50')).toBe(true)
    expect(q('1234.50')).toBe(true)
    expect(q('trader rent')).toBe(false)
    // without the haystack only the payee is searched
    expect(matchesFilter(t, { ...NO_FILTER, query: 'trader' })).toBe(true)
    expect(matchesFilter(t, { ...NO_FILTER, query: 'groceries' })).toBe(false)
  })

  it('counts a text search as a filter and drops a blank one from the hash', () => {
    expect(isFiltered({ ...NO_FILTER, query: 'rent' })).toBe(true)
    expect(parseFilter('q=%20%20')).toEqual(NO_FILTER)
    expect(filterHref({ ...NO_FILTER, query: 'a b' })).toBe('#/accounts?q=a+b')
  })
})
