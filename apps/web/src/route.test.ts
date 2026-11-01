import { describe, expect, it } from 'vitest'
import { NO_FILTER } from './register-filter.ts'
import { hrefFor, parseRoute } from './route.ts'

describe('the All Accounts filter in the hash', () => {
  it('reads a category activity link as that month', () => {
    expect(parseRoute(hrefFor.categoryActivity('cat 1&2', '2026-10'))).toEqual({
      view: 'accounts',
      filter: {
        categoryId: 'cat 1&2',
        accountId: null,
        from: '2026-10-01',
        to: '2026-10-31',
        query: null,
      },
    })
  })

  it('is unfiltered without a query', () => {
    expect(parseRoute('#/accounts')).toEqual({ view: 'accounts', filter: NO_FILTER })
  })

  it('leaves a single account alone', () => {
    expect(parseRoute('#/accounts/abc?category=a&from=2026-10-01')).toEqual({
      view: 'account',
      id: 'abc',
    })
  })
})

describe('the budget month in the hash', () => {
  it('follows today without a month', () => {
    expect(parseRoute('#/budget')).toEqual({ view: 'budget', month: null })
    expect(parseRoute('')).toEqual({ view: 'budget', month: null })
  })

  it('reads a month from the path', () => {
    expect(parseRoute(hrefFor.budgetFor('2026-08'))).toEqual({ view: 'budget', month: '2026-08' })
  })

  it('ignores anything that is not a month', () => {
    expect(parseRoute('#/budget/soon')).toEqual({ view: 'budget', month: null })
    expect(parseRoute('#/budget/2026-8')).toEqual({ view: 'budget', month: null })
  })

  it('does not take a month from another page', () => {
    expect(parseRoute('#/nowhere/2026-08')).toEqual({ view: 'budget', month: null })
  })
})
