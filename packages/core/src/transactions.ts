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
  /** Shared by the two legs of a transfer; null on an ordinary transaction. */
  transferPairId: string | null
  /** The account on the other leg of a transfer; null if this isn't one or the other leg is gone. */
  transferAccountId: string | null
  splits: TransactionSplit[]
}

export interface AccountBalance {
  accountId: string
  /** Every transaction in the account. */
  balance: number
  /** Only cleared transactions. */
  cleared: number
}

/** One line of a split transaction, as entered. */
export interface SplitInput {
  categoryId: string | null
  /** Integer cents, signed like the transaction. */
  amount: number
}

interface NewTransactionBase {
  accountId: string
  date: string
  payee?: string
  cleared?: boolean
}

export type NewTransaction = NewTransactionBase &
  (
    | {
        categoryId?: string | null
        /** Integer cents; negative for spending, positive for income. */
        amount: number
        splits?: undefined
      }
    | {
        /** One or more lines; the transaction's amount is their sum. */
        splits: SplitInput[]
        categoryId?: undefined
        amount?: undefined
      }
  )

export interface TransactionPatch {
  date?: string
  payee?: string | null
  cleared?: boolean
  /** Changes the single split; refused on a transaction with several. */
  categoryId?: string | null
  /** Same restriction as `categoryId`. */
  amount?: number
  /** Replaces every split, and the amount with their sum. Not combinable with `categoryId` or `amount`. */
  splits?: SplitInput[]
}

export interface NewTransfer {
  fromAccountId: string
  toAccountId: string
  date: string
  /** Positive integer cents leaving `fromAccountId` and arriving in `toAccountId`. */
  amount: number
  /**
   * Only for a transfer between a budget account and a tracking account, where the money
   * leaves or joins the budget: the category of that leg. Without one, it is uncategorized.
   */
  categoryId?: string | null
  cleared?: boolean
}

export interface TransactionsApi {
  /** Newest first. */
  listTransactions(filter?: { accountId?: string }): Promise<Transaction[]>
  /** Manual entry of a transaction in one category, or split across several. */
  createTransaction(input: NewTransaction): Promise<Transaction>
  /**
   * Moves money between two accounts as a pair of transactions, `[out, in]`. Between two
   * budget accounts nothing changes in the budget; to or from a tracking account the budget
   * side is spending or income, so it may carry a category.
   */
  createTransfer(input: NewTransfer): Promise<[out: Transaction, into: Transaction]>
  /**
   * On a transfer leg the amount is mirrored onto the other leg; the payee and splits can't
   * be changed, and a category only on the budget leg of a budget-to-tracking transfer.
   */
  updateTransaction(id: string, changes: TransactionPatch): Promise<Transaction>
  /** Deleting either leg of a transfer deletes both. */
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
  transfer_pair_id: string | null
  transfer_account_id: string | null
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

/** Validates split lines and returns the transaction amount they add up to. */
function assertSplits(splits: SplitInput[]): number {
  if (splits.length === 0) throw new Error('A transaction needs at least one split')
  let total = 0
  for (const split of splits) {
    try {
      cents(split.amount)
    } catch {
      throw new Error('Amount must be a whole number of cents')
    }
    if (split.amount === 0) throw new Error('Each split needs an amount')
    total += split.amount
  }
  assertAmount(total)
  return total
}

const cleanPayee = (payee: string | null | undefined) => payee?.trim() || null

async function assertCategoryExists(db: SqlRunner, id: string) {
  const [row] = await db.query('SELECT 1 AS x FROM categories WHERE id = ?', [id])
  if (!row) throw new Error('Category not found')
}

/** Card payment categories fill themselves from the card's purchases and payments. */
async function assertNotPaymentCategory(db: SqlRunner, id: string) {
  const [row] = await db.query(
    'SELECT 1 AS x FROM categories WHERE id = ? AND credit_card_account_id IS NOT NULL',
    [id],
  )
  if (row) throw new Error('A credit card payment category can’t be used on a transaction')
}

async function assertCategoriesExist(db: SqlRunner, splits: SplitInput[]) {
  for (const id of new Set(splits.flatMap((s) => (s.categoryId ? [s.categoryId] : [])))) {
    await assertCategoryExists(db, id)
    await assertNotPaymentCategory(db, id)
  }
}

export async function loadTransactions(
  db: SqlRunner,
  where: string,
  params: string[],
): Promise<Transaction[]> {
  const rows = await db.query<TransactionRow & Record<string, never>>(
    `SELECT id, account_id, date, payee, amount, cleared, reconciled, transfer_pair_id,
       (SELECT p.account_id FROM transactions p
         WHERE p.transfer_pair_id = t.transfer_pair_id AND p.id <> t.id) AS transfer_account_id
     FROM transactions t ${where} ORDER BY date DESC, created_at DESC, id DESC`,
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
    transferPairId: r.transfer_pair_id,
    transferAccountId: r.transfer_account_id,
    splits: byTransaction.get(r.id) ?? [],
  }))
}

export function transactionsApi({ adapter, newId, now, changes: log }: CrudDeps): TransactionsApi {
  async function get(db: SqlRunner, id: string): Promise<Transaction> {
    const [found] = await loadTransactions(db, 'WHERE t.id = ?', [id])
    if (!found) throw new Error('Transaction not found')
    return found
  }

  async function partnerOf(db: SqlRunner, t: Transaction): Promise<Transaction | null> {
    if (t.transferPairId === null) return null
    const [other] = await loadTransactions(db, 'WHERE t.transfer_pair_id = ? AND t.id <> ?', [
      t.transferPairId,
      t.id,
    ])
    return other ?? null
  }

  async function onBudget(db: SqlRunner, accountId: string): Promise<boolean> {
    const [row] = await db.query<{ on_budget: number }>(
      'SELECT on_budget FROM accounts WHERE id = ?',
      [accountId],
    )
    return row?.on_budget === 1
  }

  /** Changes to one leg of a transfer; the amount carries over to the other leg. */
  async function updateLeg(tx: SqlRunner, current: Transaction, patch: TransactionPatch) {
    if (patch.payee !== undefined || patch.splits) {
      throw new Error('A transfer has no payee and can’t be split')
    }
    if (patch.amount !== undefined && Math.sign(patch.amount) !== Math.sign(current.amount)) {
      throw new Error('A transfer keeps its direction; delete it and enter it the other way round')
    }
    const partner = await partnerOf(tx, current)
    if (patch.amount !== undefined && partner?.reconciled) {
      throw new Error('The other side of this transfer is reconciled and locked')
    }
    if (patch.categoryId) {
      const budgetToTracking =
        partner !== null &&
        (await onBudget(tx, current.accountId)) &&
        !(await onBudget(tx, partner.accountId))
      if (!budgetToTracking) {
        throw new Error('Only the budget side of a transfer to a tracking account takes a category')
      }
      await assertCategoryExists(tx, patch.categoryId)
      await assertNotPaymentCategory(tx, patch.categoryId)
    }
    const changes = log(tx)
    const amount = patch.amount ?? current.amount
    await changes.update('transactions', current.id, {
      date: patch.date ?? current.date,
      amount,
      cleared: flag(patch.cleared ?? current.cleared),
    })
    const [only] = current.splits
    if (only) {
      await changes.update('transaction_splits', only.id, {
        category_id: patch.categoryId === undefined ? only.categoryId : patch.categoryId || null,
        amount,
      })
    }
    if (partner && patch.amount !== undefined) {
      await changes.update('transactions', partner.id, { amount: -amount })
      const [theirs] = partner.splits
      if (theirs) await changes.update('transaction_splits', theirs.id, { amount: -amount })
    }
    return get(tx, current.id)
  }

  return {
    listTransactions: (filter = {}) =>
      filter.accountId === undefined
        ? loadTransactions(adapter, '', [])
        : loadTransactions(adapter, 'WHERE t.account_id = ?', [filter.accountId]),

    async createTransaction(input) {
      const { accountId, date, payee, cleared } = input
      const lines: SplitInput[] = input.splits ?? [
        { categoryId: input.categoryId || null, amount: input.amount },
      ]
      assertDate(date)
      if (input.splits) assertSplits(lines)
      else assertAmount(input.amount)
      const amount = lines.reduce((sum, line) => sum + line.amount, 0)
      return adapter.transaction(async (tx) => {
        const [account] = await tx.query<{ closed: number }>(
          'SELECT closed FROM accounts WHERE id = ?',
          [accountId],
        )
        if (!account) throw new Error('Account not found')
        if (account.closed === 1) throw new Error('This account is closed')
        await assertCategoriesExist(tx, lines)
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
        for (const line of lines) {
          await changes.insert('transaction_splits', {
            id: newId(),
            transaction_id: id,
            category_id: line.categoryId || null,
            amount: line.amount,
            created_at: at,
          })
        }
        return get(tx, id)
      })
    },

    async createTransfer({ fromAccountId, toAccountId, date, amount, categoryId, cleared }) {
      assertDate(date)
      assertAmount(amount)
      if (amount < 0) throw new Error('Transfer amount must be positive')
      if (fromAccountId === toAccountId) throw new Error('Pick two different accounts')
      return adapter.transaction(async (tx) => {
        const accounts = new Map<string, { closed: number; on_budget: number }>()
        for (const id of [fromAccountId, toAccountId]) {
          const [account] = await tx.query<{ closed: number; on_budget: number }>(
            'SELECT closed, on_budget FROM accounts WHERE id = ?',
            [id],
          )
          if (!account) throw new Error('Account not found')
          if (account.closed === 1) throw new Error('This account is closed')
          accounts.set(id, account)
        }
        const from = accounts.get(fromAccountId)!
        const to = accounts.get(toAccountId)!
        if (categoryId) {
          if (from.on_budget === to.on_budget) {
            throw new Error(
              'Only a transfer between a budget and a tracking account takes a category',
            )
          }
          await assertCategoryExists(tx, categoryId)
          await assertNotPaymentCategory(tx, categoryId)
        }
        const pairId = newId()
        const at = now()
        const changes = log(tx)
        const ids: string[] = []
        for (const leg of [
          { accountId: fromAccountId, amount: -amount, budget: from.on_budget === 1 },
          { accountId: toAccountId, amount, budget: to.on_budget === 1 },
        ]) {
          const id = newId()
          ids.push(id)
          await changes.insert('transactions', {
            id,
            account_id: leg.accountId,
            date,
            payee: null,
            amount: leg.amount,
            cleared: flag(cleared ?? false),
            reconciled: 0,
            transfer_pair_id: pairId,
            created_at: at,
          })
          await changes.insert('transaction_splits', {
            id: newId(),
            transaction_id: id,
            category_id: leg.budget ? categoryId || null : null,
            amount: leg.amount,
            created_at: at,
          })
        }
        return [await get(tx, ids[0]!), await get(tx, ids[1]!)]
      })
    },

    async updateTransaction(id, patch) {
      if (patch.date !== undefined) assertDate(patch.date)
      if (patch.amount !== undefined) assertAmount(patch.amount)
      if (patch.splits && (patch.categoryId !== undefined || patch.amount !== undefined)) {
        throw new Error('Change either the splits or the category and amount, not both')
      }
      const amount = patch.splits ? assertSplits(patch.splits) : patch.amount
      return adapter.transaction(async (tx) => {
        const current = await get(tx, id)
        if (current.reconciled) throw new Error('This transaction is reconciled and locked')
        if (current.transferPairId !== null) return updateLeg(tx, current, patch)
        const changes = log(tx)
        await changes.update('transactions', id, {
          date: patch.date ?? current.date,
          payee: patch.payee === undefined ? current.payee : cleanPayee(patch.payee),
          amount: amount ?? current.amount,
          cleared: flag(patch.cleared ?? current.cleared),
        })
        if (patch.splits) {
          await assertCategoriesExist(tx, patch.splits)
          // Lines keep their rows by position so an edit only logs what changed.
          const at = now()
          for (const [i, line] of patch.splits.entries()) {
            const existing = current.splits[i]
            if (existing) {
              await changes.update('transaction_splits', existing.id, {
                category_id: line.categoryId || null,
                amount: line.amount,
              })
            } else {
              await changes.insert('transaction_splits', {
                id: newId(),
                transaction_id: id,
                category_id: line.categoryId || null,
                amount: line.amount,
                created_at: at,
              })
            }
          }
          for (const extra of current.splits.slice(patch.splits.length)) {
            await changes.delete('transaction_splits', extra.id)
          }
          return get(tx, id)
        }
        const touchesSplit = patch.categoryId !== undefined || patch.amount !== undefined
        if (touchesSplit) {
          const [only, ...rest] = current.splits
          if (!only || rest.length > 0) {
            throw new Error('Split transactions can’t change category or amount here')
          }
          if (patch.categoryId) {
            await assertCategoryExists(tx, patch.categoryId)
            await assertNotPaymentCategory(tx, patch.categoryId)
          }
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
        const partner = await partnerOf(tx, current)
        if (partner?.reconciled) {
          throw new Error('The other side of this transfer is reconciled and locked')
        }
        const changes = log(tx)
        for (const gone of partner ? [current, partner] : [current]) {
          for (const split of gone.splits) await changes.delete('transaction_splits', split.id)
          await changes.delete('transactions', gone.id)
        }
      })
    },

    async getAccountBalances() {
      const rows = await adapter.query<{ id: string; balance: number; cleared: number }>(
        `SELECT a.id AS id,
           COALESCE(SUM(t.amount), 0) AS balance,
           COALESCE(SUM(CASE WHEN t.cleared = 1 THEN t.amount END), 0) AS cleared
         FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
         GROUP BY a.id ORDER BY a.created_at, a.id`,
      )
      return rows.map((r) => ({ accountId: r.id, balance: r.balance, cleared: r.cleared }))
    },
  }
}
