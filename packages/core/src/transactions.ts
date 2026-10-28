import type { CrudDeps } from './crud.ts'
import { flag } from './crud.ts'
import { cents } from './money.ts'
import type { SqlRunner } from './storage.ts'

export interface TransactionSplit {
  id: string
  /** Null means uncategorized; on a budget account an uncategorized inflow is income. */
  categoryId: string | null
  amount: number
}

export interface Transaction {
  id: string
  accountId: string
  /** `YYYY-MM-DD` */
  date: string
  payee: string | null
  /** Integer cents; spending is negative. Always equals the sum of its splits. */
  amount: number
  cleared: boolean
  reconciled: boolean
  splits: TransactionSplit[]
}

export interface AccountBalance {
  accountId: string
  /** Every transaction in the account. */
  balance: number
  /** Only cleared transactions. */
  cleared: number
}

export interface TransactionsApi {
  /** Newest first. */
  listTransactions(filter?: { accountId?: string }): Promise<Transaction[]>
  /** Manual entry of a one-category transaction. */
  createTransaction(input: {
    accountId: string
    date: string
    payee?: string
    categoryId?: string | null
    /** Integer cents; negative for spending, positive for income. */
    amount: number
    cleared?: boolean
  }): Promise<Transaction>
  /** Category and amount can only change on a transaction with a single split. */
  updateTransaction(
    id: string,
    changes: {
      date?: string
      payee?: string | null
      categoryId?: string | null
      amount?: number
      cleared?: boolean
    },
  ): Promise<Transaction>
  deleteTransaction(id: string): Promise<void>
  getAccountBalances(): Promise<AccountBalance[]>
}

interface TransactionRow {
  id: string
  account_id: string
  date: string
  payee: string | null
  amount: number
  cleared: number
  reconciled: number
}

interface SplitRow {
  id: string
  transaction_id: string
  category_id: string | null
  amount: number
}

const DATE = /^\d{4}-\d\d-\d\d$/

export function assertDate(date: string): void {
  const valid = DATE.test(date) && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date)
  if (!valid) throw new Error(`"${date}" is not a date (expected YYYY-MM-DD)`)
}

function assertAmount(amount: number): void {
  try {
    cents(amount)
  } catch {
    throw new Error('Amount must be a whole number of cents')
  }
  if (amount === 0) throw new Error('Amount cannot be zero')
}

const cleanPayee = (payee: string | null | undefined) => payee?.trim() || null

async function assertCategoryExists(db: SqlRunner, id: string) {
  const [row] = await db.query('SELECT 1 AS x FROM categories WHERE id = ?', [id])
  if (!row) throw new Error('Category not found')
}

export function transactionsApi({ adapter, newId, now, changes: log }: CrudDeps): TransactionsApi {
  async function load(db: SqlRunner, where: string, params: string[]): Promise<Transaction[]> {
    const rows = await db.query<TransactionRow & Record<string, never>>(
      `SELECT id, account_id, date, payee, amount, cleared, reconciled FROM transactions t
       ${where} ORDER BY date DESC, rowid DESC`,
      params,
    )
    if (rows.length === 0) return []
    const splits = await db.query<SplitRow & Record<string, never>>(
      `SELECT s.id, s.transaction_id, s.category_id, s.amount FROM transaction_splits s
       JOIN transactions t ON t.id = s.transaction_id ${where} ORDER BY s.rowid`,
      params,
    )
    const byTransaction = new Map<string, TransactionSplit[]>()
    for (const s of splits) {
      const list = byTransaction.get(s.transaction_id) ?? []
      list.push({ id: s.id, categoryId: s.category_id, amount: s.amount })
      byTransaction.set(s.transaction_id, list)
    }
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      date: r.date,
      payee: r.payee,
      amount: r.amount,
      cleared: r.cleared === 1,
      reconciled: r.reconciled === 1,
      splits: byTransaction.get(r.id) ?? [],
    }))
  }

  async function get(db: SqlRunner, id: string): Promise<Transaction> {
    const [found] = await load(db, 'WHERE t.id = ?', [id])
    if (!found) throw new Error('Transaction not found')
    return found
  }

  return {
    listTransactions: (filter = {}) =>
      filter.accountId === undefined
        ? load(adapter, '', [])
        : load(adapter, 'WHERE t.account_id = ?', [filter.accountId]),

    async createTransaction({ accountId, date, payee, categoryId, amount, cleared }) {
      assertDate(date)
      assertAmount(amount)
      return adapter.transaction(async (tx) => {
        const [account] = await tx.query<{ closed: number }>(
          'SELECT closed FROM accounts WHERE id = ?',
          [accountId],
        )
        if (!account) throw new Error('Account not found')
        if (account.closed === 1) throw new Error('This account is closed')
        if (categoryId) await assertCategoryExists(tx, categoryId)
        const id = newId()
        const at = now()
        const changes = log(tx)
        await changes.insert('transactions', {
          id,
          account_id: accountId,
          date,
          payee: cleanPayee(payee),
          amount,
          cleared: flag(cleared ?? false),
          reconciled: 0,
          created_at: at,
        })
        await changes.insert('transaction_splits', {
          id: newId(),
          transaction_id: id,
          category_id: categoryId || null,
          amount,
          created_at: at,
        })
        return get(tx, id)
      })
    },

    async updateTransaction(id, patch) {
      if (patch.date !== undefined) assertDate(patch.date)
      if (patch.amount !== undefined) assertAmount(patch.amount)
      return adapter.transaction(async (tx) => {
        const current = await get(tx, id)
        if (current.reconciled) throw new Error('This transaction is reconciled and locked')
        const changes = log(tx)
        await changes.update('transactions', id, {
          date: patch.date ?? current.date,
          payee: patch.payee === undefined ? current.payee : cleanPayee(patch.payee),
          amount: patch.amount ?? current.amount,
          cleared: flag(patch.cleared ?? current.cleared),
        })
        const touchesSplit = patch.categoryId !== undefined || patch.amount !== undefined
        if (touchesSplit) {
          const [only, ...rest] = current.splits
          if (!only || rest.length > 0) {
            throw new Error('Split transactions can’t change category or amount here')
          }
          if (patch.categoryId) await assertCategoryExists(tx, patch.categoryId)
          await changes.update('transaction_splits', only.id, {
            category_id:
              patch.categoryId === undefined ? only.categoryId : patch.categoryId || null,
            amount: patch.amount ?? only.amount,
          })
        }
        return get(tx, id)
      })
    },

    async deleteTransaction(id) {
      await adapter.transaction(async (tx) => {
        const current = await get(tx, id)
        if (current.reconciled) throw new Error('This transaction is reconciled and locked')
        const changes = log(tx)
        for (const split of current.splits) await changes.delete('transaction_splits', split.id)
        await changes.delete('transactions', id)
      })
    },

    async getAccountBalances() {
      const rows = await adapter.query<{ id: string; balance: number; cleared: number }>(
        `SELECT a.id AS id,
           COALESCE(SUM(t.amount), 0) AS balance,
           COALESCE(SUM(CASE WHEN t.cleared = 1 THEN t.amount END), 0) AS cleared
         FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
         GROUP BY a.id ORDER BY a.created_at, a.rowid`,
      )
      return rows.map((r) => ({ accountId: r.id, balance: r.balance, cleared: r.cleared }))
    },
  }
}
