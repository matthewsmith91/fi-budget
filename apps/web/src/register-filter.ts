import { cents, formatCents, type Transaction } from '@budget-fi/core'

/** What narrows the All Accounts register. An empty part doesn't narrow. */
export interface RegisterFilter {
  categoryId: string | null
  accountId: string | null
  /** Inclusive `YYYY-MM-DD` bounds. */
  from: string | null
  to: string | null
  /** Words that must all appear in a transaction's payee, category, account or amount. */
  query: string | null
}

export const NO_FILTER: RegisterFilter = {
  categoryId: null,
  accountId: null,
  from: null,
  to: null,
  query: null,
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function isFiltered(filter: RegisterFilter): boolean {
  return !!(filter.categoryId || filter.accountId || filter.from || filter.to || filter.query)
}

/** Reads the query part of the hash; anything malformed is ignored. */
export function parseFilter(query: string): RegisterFilter {
  const params = new URLSearchParams(query)
  const date = (key: string) => {
    const value = params.get(key)
    return value && DATE.test(value) ? value : null
  }
  return {
    categoryId: params.get('category') || null,
    accountId: params.get('account') || null,
    from: date('from'),
    to: date('to'),
    query: params.get('q')?.trim() || null,
  }
}

/** The hash for All Accounts with this filter. */
export function filterHref(filter: RegisterFilter): string {
  const params = new URLSearchParams()
  if (filter.categoryId) params.set('category', filter.categoryId)
  if (filter.accountId) params.set('account', filter.accountId)
  if (filter.from) params.set('from', filter.from)
  if (filter.to) params.set('to', filter.to)
  if (filter.query) params.set('q', filter.query)
  const query = params.toString()
  return query ? `#/accounts?${query}` : '#/accounts'
}

/** One category over one whole month, which is what a budget row's Activity adds up. */
export function monthFilter(categoryId: string, month: string): RegisterFilter {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return {
    ...NO_FILTER,
    categoryId,
    from: `${month}-01`,
    to: `${month}-${String(last).padStart(2, '0')}`,
  }
}

/**
 * What a text search looks through for one transaction: the words shown on its row plus its amount
 * both as shown (`1,234.50`) and as typed (`1234.50`). Lower case.
 */
export function searchText(words: (string | null | undefined)[], amount: number): string {
  const shown = formatCents(cents(Math.abs(amount)), { symbol: false })
  return [...words, shown, shown.replaceAll(',', '')]
    .filter((w): w is string => !!w)
    .join(' ')
    .toLowerCase()
}

/** True when every word of `query` appears in `haystack` (already lower case). */
export function matchesQuery(haystack: string, query: string): boolean {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
}

/**
 * `haystack` is the transaction's `searchText`; without it a text query looks at the payee only.
 */
export function matchesFilter(t: Transaction, filter: RegisterFilter, haystack?: string): boolean {
  if (filter.accountId && t.accountId !== filter.accountId) return false
  if (filter.from && t.date < filter.from) return false
  if (filter.to && t.date > filter.to) return false
  if (filter.categoryId && !t.splits.some((s) => s.categoryId === filter.categoryId)) return false
  if (filter.query && !matchesQuery(haystack ?? (t.payee ?? '').toLowerCase(), filter.query)) {
    return false
  }
  return true
}

/** The matching lines' total in the category, like the budget's Activity (all of it in a split). */
export function categoryTotal(transactions: Transaction[], categoryId: string): number {
  return transactions.reduce(
    (n, t) => t.splits.reduce((m, s) => (s.categoryId === categoryId ? m + s.amount : m), n),
    0,
  )
}
