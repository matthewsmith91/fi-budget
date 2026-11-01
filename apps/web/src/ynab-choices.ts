import type { AccountType, YnabAccountChoice, YnabAccountPreview } from '@budget-fi/core'

export interface Choice {
  mode: 'existing' | 'create'
  accountId: string
  type: AccountType
  onBudget: boolean
}

/** A reasonable first guess at what kind of account a YNAB account is, from its name. */
export function guessAccount(name: string): { type: AccountType; onBudget: boolean } {
  if (/visa|mastercard|amex|discover|credit|card/i.test(name))
    return { type: 'credit', onBudget: true }
  if (
    /401|403|ira|roth|brokerage|invest|529|hsa|retire|stock|vanguard|fidelity|schwab/i.test(name)
  ) {
    return { type: 'investment', onBudget: false }
  }
  if (/sav|hysa|emergency|reserve/i.test(name)) return { type: 'savings', onBudget: true }
  return { type: 'checking', onBudget: true }
}

/**
 * Starts from the account that already has this name, if there is an open one, else a new one.
 * What the file shows beats what the name suggests: an account YNAB kept out of the budget
 * (a mortgage, a bond, a pension) starts as tracking, so a categorized transfer into it is
 * spending from its category as it was in YNAB.
 */
export function defaultChoice(account: YnabAccountPreview): Choice {
  const guess = guessAccount(account.name)
  const type = guess.type
  const onBudget = account.tracking ? false : guess.onBudget
  const match = account.match
  return match && !match.closed
    ? { mode: 'existing', accountId: match.accountId, type, onBudget }
    : { mode: 'create', accountId: '', type, onBudget }
}

export function toChoice(c: Choice): YnabAccountChoice | null {
  if (c.mode === 'existing') return c.accountId ? { accountId: c.accountId } : null
  return { create: { type: c.type, onBudget: c.type === 'investment' ? false : c.onBudget } }
}
