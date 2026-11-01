import type { Account, AccountMapping, ImportAccount, ImportSummary } from '@budget-fi/core'
import type { ExternalAccount } from './bank.ts'

/** The first day of the month `today` (`YYYY-MM-DD`) falls in. */
export const firstOfMonth = (today: string) => `${today.slice(0, 8)}01`

/** Days to ask SimpleFIN for so the window starts on the first of the month, today included. */
export const daysThisMonth = (today: string) => Number(today.slice(8, 10))

/**
 * The balance to open an account at so that, once its fetched transactions are imported, it
 * ends on the bank's balance. Imported transactions count in balances straight away, so the
 * starting balance is what the bank held before them, not what it holds now.
 */
export const openingBalance = (bank: Pick<ExternalAccount, 'balance' | 'transactions'>) =>
  bank.transactions.reduce((sum, t) => sum - t.amount, bank.balance)

/** Bank accounts nothing is linked to yet; one app account takes one bank account. */
export const unlinkedBankAccounts = (fetched: ExternalAccount[], mappings: AccountMapping[]) => {
  const taken = new Set(mappings.flatMap((m) => (m.accountId ? [m.externalId] : [])))
  return fetched.filter((a) => !taken.has(a.id))
}

export interface OpenDeps {
  mapExternalAccount(input: {
    externalId: string
    name: string
    org?: string
    accountId: string | null
  }): Promise<AccountMapping>
  importTransactions(accounts: ImportAccount[]): Promise<ImportSummary>
  createTransaction(input: {
    accountId: string
    date: string
    payee: string
    amount: number
    cleared: boolean
  }): Promise<unknown>
  recordBankBalances(
    balances: { externalId: string; balance: number; balanceDate: string | null }[],
  ): Promise<number>
}

/**
 * Links a new app account to a bank account and brings the bank's figures in: for a checking,
 * savings or credit account the month's transactions go to the inbox and a starting balance
 * makes up the rest; an investment account is valued at the bank's balance instead. Every step
 * is safe to run again on the same account, so a failure part-way can simply be retried.
 */
export async function openFromBank(
  deps: OpenDeps,
  account: Pick<Account, 'id' | 'type'>,
  bank: ExternalAccount,
  today: string,
): Promise<void> {
  await deps.mapExternalAccount({
    externalId: bank.id,
    name: bank.name,
    org: bank.org,
    accountId: account.id,
  })
  if (account.type === 'investment') {
    await deps.recordBankBalances([
      { externalId: bank.id, balance: bank.balance, balanceDate: bank.balanceDate },
    ])
    return
  }
  await deps.importTransactions([
    { id: bank.id, name: bank.name, org: bank.org, transactions: bank.transactions },
  ])
  const start = openingBalance(bank)
  if (start !== 0) {
    await deps.createTransaction({
      accountId: account.id,
      date: firstOfMonth(today),
      payee: 'Starting Balance',
      amount: start,
      cleared: true,
    })
  }
}
