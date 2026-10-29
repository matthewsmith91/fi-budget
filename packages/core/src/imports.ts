import type { CrudDeps } from './crud.ts'
import { flag } from './crud.ts'
import { settleIncome } from './income-rules.ts'
import { loadUsableRules, matchPayeeRule } from './payee-rules.ts'
import { assertDate, loadTransactions, type Transaction } from './transactions.ts'
import type { SqlRunner } from './storage.ts'

/** How far a bank's posting date may sit from the date a person typed and still be the same purchase. */
export const MATCH_WINDOW_DAYS = 3

/** A bank transaction as the server fetched it: integer cents, negative is money out. */
export interface ImportTransaction {
  id: string
  /** The day it posted, `YYYY-MM-DD`. */
  posted: string
  amount: number
  description: string
}

export interface ImportAccount {
  /** The bank's id for the account, stable across fetches. */
  id: string
  name: string
  org?: string
  transactions: ImportTransaction[]
}

export interface AccountMapping {
  /** The bank's account id. */
  externalId: string
  name: string
  org: string
  /** The app account its transactions land in; null while unmapped. */
  accountId: string | null
}

export interface ImportSummary {
  /** New transactions, waiting in the inbox. */
  added: number
  /** Bank transactions folded into a manual entry that was already there. */
  matched: number
  /** Seen before, so left alone. */
  alreadyImported: number
  /** Thrown away earlier, so left out. */
  dismissed: number
  /** Bank accounts with transactions but nowhere to put them. */
  unmapped: { externalId: string; name: string; transactions: number }[]
}

/** An inbox transaction, with the manual entries it may be a second copy of. */
export interface InboxItem {
  transaction: Transaction
  possibleDuplicates: Transaction[]
}

export interface ImportsApi {
  listAccountMappings(): Promise<AccountMapping[]>
  /**
   * Links a bank account to an app account, or unlinks it with `accountId: null`. One app
   * account takes one bank account.
   */
  mapExternalAccount(input: {
    externalId: string
    name: string
    org?: string
    accountId: string | null
  }): Promise<AccountMapping>
  /**
   * Brings fetched bank transactions into the budget. Each one that is new becomes a
   * cleared transaction in the inbox, categorized by a payee rule if one fits; one that
   * matches a manual entry (same amount, within a few days) is folded into it instead of
   * being added a second time.
   * Running it again on the same data changes nothing.
   */
  importTransactions(accounts: ImportAccount[]): Promise<ImportSummary>
  /** Everything waiting for approval, oldest first. */
  listInbox(): Promise<InboxItem[]>
  /** Takes transactions out of the inbox as they are. */
  approveTransactions(ids: string[]): Promise<void>
  /**
   * Folds an inbox transaction into a manual entry that is the same purchase: the entry keeps
   * its payee and category, takes the bank's id and becomes cleared, and the inbox copy goes.
   */
  mergeImport(importedId: string, intoId: string): Promise<Transaction>
}

interface MappingRow {
  id: string
  name: string
  org: string
  account_id: string | null
}

const toMapping = (r: MappingRow): AccountMapping => ({
  externalId: r.id,
  name: r.name,
  org: r.org,
  accountId: r.account_id,
})

/** A bank's id for a transaction is only unique within its account. */
const importKey = (externalAccountId: string, transactionId: string) =>
  `${externalAccountId}:${transactionId}`

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000

const squash = (s: string | null) =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** 2 when one name contains the other ("Costco" in "COSTCO WHSE #12"), 1 for a shared word, else 0. */
function payeeScore(a: string | null, b: string | null): number {
  const x = squash(a)
  const y = squash(b)
  if (!x || !y) return 0
  if (x.includes(y) || y.includes(x)) return 2
  const words = new Set(x.split(' ').filter((w) => w.length >= 3))
  return y.split(' ').some((w) => words.has(w)) ? 1 : 0
}

/**
 * Manual entries a bank transaction could be: the same amount in the same account, a few
 * days either side, not already tied to the bank and not locked. The closest date comes
 * first, then the best payee match.
 */
async function findMatches(
  db: SqlRunner,
  bank: { accountId: string; date: string; amount: number; payee: string | null; id?: string },
): Promise<Transaction[]> {
  const found = await loadTransactions(
    db,
    `WHERE t.account_id = ? AND t.amount = ? AND t.date BETWEEN ? AND ?
       AND t.import_id IS NULL AND t.approved = 1 AND t.reconciled = 0
       AND t.transfer_pair_id IS NULL AND t.id <> ?`,
    [
      bank.accountId,
      String(bank.amount),
      addDays(bank.date, -MATCH_WINDOW_DAYS),
      addDays(bank.date, MATCH_WINDOW_DAYS),
      bank.id ?? '',
    ],
  )
  const apart = (t: Transaction) => Math.abs(dayNumber(t.date) - dayNumber(bank.date))
  return found.sort(
    (a, b) =>
      apart(a) - apart(b) ||
      payeeScore(b.payee, bank.payee) - payeeScore(a.payee, bank.payee) ||
      a.id.localeCompare(b.id),
  )
}

export function importsApi({ adapter, now, changes: log }: CrudDeps): ImportsApi {
  async function mapping(db: SqlRunner, externalId: string): Promise<AccountMapping | null> {
    const [row] = await db.query<MappingRow & Record<string, never>>(
      'SELECT id, name, org, account_id FROM external_accounts WHERE id = ?',
      [externalId],
    )
    return row ? toMapping(row) : null
  }

  return {
    async listAccountMappings() {
      const rows = await adapter.query<MappingRow & Record<string, never>>(
        'SELECT id, name, org, account_id FROM external_accounts ORDER BY created_at, id',
      )
      return rows.map(toMapping)
    },

    async mapExternalAccount({ externalId, name, org = '', accountId }) {
      if (!externalId) throw new Error('A bank account id is required')
      return adapter.transaction(async (tx) => {
        if (accountId !== null) {
          const [account] = await tx.query<{ closed: number }>(
            'SELECT closed FROM accounts WHERE id = ?',
            [accountId],
          )
          if (!account) throw new Error('Account not found')
          if (account.closed === 1) throw new Error('This account is closed')
          const [taken] = await tx.query<{ name: string }>(
            'SELECT name FROM external_accounts WHERE account_id = ? AND id <> ?',
            [accountId, externalId],
          )
          if (taken) throw new Error(`Already linked to the bank account “${taken.name}”`)
        }
        const changes = log(tx)
        if (await mapping(tx, externalId)) {
          await changes.update('external_accounts', externalId, {
            name,
            org,
            account_id: accountId,
          })
        } else {
          await changes.insert('external_accounts', {
            id: externalId,
            name,
            org,
            account_id: accountId,
            created_at: now(),
          })
        }
        return (await mapping(tx, externalId))!
      })
    },

    async importTransactions(accounts) {
      const summary: ImportSummary = {
        added: 0,
        matched: 0,
        alreadyImported: 0,
        dismissed: 0,
        unmapped: [],
      }
      return adapter.transaction(async (tx) => {
        const changes = log(tx)
        const at = now()
        const rules = await loadUsableRules(tx)
        for (const external of accounts) {
          const link = await mapping(tx, external.id)
          let target: string | null = null
          let budgeted = false
          if (link?.accountId) {
            const [account] = await tx.query<{ closed: number; on_budget: number }>(
              'SELECT closed, on_budget FROM accounts WHERE id = ?',
              [link.accountId],
            )
            if (account && account.closed === 0) {
              target = link.accountId
              budgeted = account.on_budget === 1
            }
          }
          if (target === null) {
            if (external.transactions.length > 0) {
              summary.unmapped.push({
                externalId: external.id,
                name: external.name,
                transactions: external.transactions.length,
              })
            }
            continue
          }
          // Oldest first and in a fixed order, so matching gives the same answer on every device.
          const ordered = external.transactions.toSorted(
            (a, b) => a.posted.localeCompare(b.posted) || a.id.localeCompare(b.id),
          )
          for (const bank of ordered) {
            assertDate(bank.posted)
            if (!Number.isSafeInteger(bank.amount)) {
              throw new Error('Amount must be a whole number of cents')
            }
            if (bank.amount === 0) continue
            const key = importKey(external.id, bank.id)
            const [seen] = await tx.query('SELECT 1 AS x FROM transactions WHERE import_id = ?', [
              key,
            ])
            if (seen) {
              summary.alreadyImported++
              continue
            }
            const [gone] = await tx.query('SELECT 1 AS x FROM dismissed_imports WHERE id = ?', [
              key,
            ])
            if (gone) {
              summary.dismissed++
              continue
            }
            const payee = bank.description.trim() || null
            const [match] = await findMatches(tx, {
              accountId: target,
              date: bank.posted,
              amount: bank.amount,
              payee,
            })
            if (match) {
              await changes.update('transactions', match.id, { import_id: key, cleared: 1 })
              summary.matched++
              continue
            }
            // Deterministic ids: two devices importing the same transaction write the same rows.
            const id = `import-${key}`
            await changes.insert('transactions', {
              id,
              account_id: target,
              date: bank.posted,
              payee,
              amount: bank.amount,
              cleared: 1,
              reconciled: 0,
              approved: 0,
              import_id: key,
              created_at: at,
            })
            // A payee rule fills in the category; the transaction still waits for approval.
            const rule = budgeted ? matchPayeeRule(rules, payee) : null
            await changes.insert('transaction_splits', {
              id: `${id}:split`,
              transaction_id: id,
              category_id: rule?.categoryId ?? null,
              amount: bank.amount,
              created_at: at,
            })
            summary.added++
          }
        }
        return summary
      })
    },

    async listInbox() {
      const waiting = (await loadTransactions(adapter, 'WHERE t.approved = 0', [])).toReversed()
      const items: InboxItem[] = []
      for (const transaction of waiting) {
        items.push({
          transaction,
          possibleDuplicates: await findMatches(adapter, {
            accountId: transaction.accountId,
            date: transaction.date,
            amount: transaction.amount,
            payee: transaction.payee,
            id: transaction.id,
          }),
        })
      }
      return items
    },

    async approveTransactions(ids) {
      await adapter.transaction(async (tx) => {
        const changes = log(tx)
        for (const id of new Set(ids)) {
          const [row] = await tx.query('SELECT 1 AS x FROM transactions WHERE id = ?', [id])
          if (!row) throw new Error('Transaction not found')
          await changes.update('transactions', id, { approved: flag(true) })
        }
        // Income waits for approval before the income rules act on it.
        await settleIncome(tx, changes, now(), ids)
      })
    },

    async mergeImport(importedId, intoId) {
      return adapter.transaction(async (tx) => {
        const [imported] = await loadTransactions(tx, 'WHERE t.id = ?', [importedId])
        if (!imported?.importId || imported.approved) {
          throw new Error('That transaction is not waiting in the inbox')
        }
        const [entry] = await loadTransactions(tx, 'WHERE t.id = ?', [intoId])
        if (!entry) throw new Error('Transaction not found')
        if (entry.reconciled) throw new Error('This transaction is reconciled and locked')
        if (
          entry.accountId !== imported.accountId ||
          entry.amount !== imported.amount ||
          entry.importId !== null ||
          entry.transferPairId !== null
        ) {
          throw new Error('Those two are not the same purchase')
        }
        const changes = log(tx)
        for (const split of imported.splits) await changes.delete('transaction_splits', split.id)
        await changes.delete('transactions', imported.id)
        await changes.update('transactions', entry.id, { import_id: imported.importId, cleared: 1 })
        return (await loadTransactions(tx, 'WHERE t.id = ?', [entry.id]))[0]!
      })
    },
  }
}
