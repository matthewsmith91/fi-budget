import { assertGoalUsable } from './allocations.ts'
import type { ChangeLog } from './changes.ts'
import { assertNeedOrWant, type NeedOrWant } from './categories.ts'
import { assertDate, flag, type CrudDeps } from './crud.ts'
import { settleIncome } from './income-rules.ts'
import { cents } from './money.ts'
import type { SqlRunner } from './storage.ts'
import { settleUnits } from './unit-ledger.ts'

// Other modules (and the UI) have always imported this from here.
export { assertDate }

export interface TransactionSplit {
  id: string
  /** Null means uncategorized; on a budget account an uncategorized inflow is income. */
  categoryId: string | null
  /** The goal of that category this line is spent from, or null for the category itself. */
  goalId: string | null
  /** Overrides the category's need/want tag for this line; null follows the category. */
  needOrWant: NeedOrWant | null
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
  /** False for a transaction imported from the bank that nobody has approved yet (the inbox). */
  approved: boolean
  /** The bank's id for an imported transaction, or one a manual entry was matched to. */
  importId: string | null
  /** Shared by the two legs of a transfer; null on an ordinary transaction. */
  transferPairId: string | null
  /** The account on the other leg of a transfer; null if this isn't one or the other leg is gone. */
  transferAccountId: string | null
  /** Pre-tax pay typed on a deposit, for income rules on a gross basis; null when not given. */
  grossAmount: number | null
  /** The deposit this outflow takes back (a reversed paycheck); null otherwise. */
  reversesId: string | null
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
  /** A goal of `categoryId` to spend from; spending from a goal is a planned draw-down. */
  goalId?: string | null
  /** Tags this line as a need or a want whatever its category says; null follows the category. */
  needOrWant?: NeedOrWant | null
  /** Integer cents, signed like the transaction. */
  amount: number
}

interface NewTransactionBase {
  accountId: string
  date: string
  payee?: string
  cleared?: boolean
  /** Pre-tax pay of a deposit; income rules on a gross basis take their percent of it. */
  grossAmount?: number | null
  /** Marks an outflow as taking back this deposit, which reverses what income rules gave it. */
  reversesId?: string | null
}

export type NewTransaction = NewTransactionBase &
  (
    | {
        categoryId?: string | null
        goalId?: string | null
        needOrWant?: NeedOrWant | null
        /** Integer cents; negative for spending, positive for income. */
        amount: number
        splits?: undefined
      }
    | {
        /** One or more lines; the transaction's amount is their sum. */
        splits: SplitInput[]
        categoryId?: undefined
        goalId?: undefined
        needOrWant?: undefined
        amount?: undefined
      }
  )

export interface TransactionPatch {
  date?: string
  payee?: string | null
  cleared?: boolean
  /** Pre-tax pay of a deposit; null clears it. */
  grossAmount?: number | null
  /** Marks this outflow as taking back a deposit; null unlinks it. */
  reversesId?: string | null
  /** Changes the single split; refused on a transaction with several. */
  categoryId?: string | null
  /**
   * Same restriction as `categoryId`. Changing the category drops the goal unless a goal of
   * the new category is named here.
   */
  goalId?: string | null
  /**
   * Same restriction as `categoryId`. Changing the category drops the override unless one
   * is named here.
   */
  needOrWant?: NeedOrWant | null
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
  /**
   * A goal of `categoryId` the contribution is for. Into an investment account, the cleared
   * transfer buys units for it; out of one, it sells them.
   */
  goalId?: string | null
  cleared?: boolean
}

export interface TransactionsApi {
  /** Newest first. */
  listTransactions(filter?: { accountId?: string; unapproved?: boolean }): Promise<Transaction[]>
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
  /**
   * Deleting either leg of a transfer deletes both. A transaction that came from the bank
   * is remembered as dismissed, so fetching the bank again does not bring it back.
   */
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
  approved: number
  import_id: string | null
  transfer_pair_id: string | null
  transfer_account_id: string | null
  gross_amount: number | null
  reverses_id: string | null
}

interface SplitRow {
  id: string
  transaction_id: string
  category_id: string | null
  goal_id: string | null
  need_or_want_override: NeedOrWant | null
  amount: number
}

/** Remembers a bank transaction that was thrown away, once, so imports skip it from now on. */
export async function dismissImport(
  db: SqlRunner,
  changes: ChangeLog,
  importId: string,
  at: string,
) {
  const [known] = await db.query('SELECT 1 AS x FROM dismissed_imports WHERE id = ?', [importId])
  if (!known) await changes.insert('dismissed_imports', { id: importId, created_at: at })
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
    if (split.needOrWant) assertNeedOrWant(split.needOrWant)
  }
  assertAmount(total)
  return total
}

const cleanPayee = (payee: string | null | undefined) => payee?.trim() || null

function assertGross(gross: number | null | undefined): void {
  if (gross === null || gross === undefined) return
  if (!Number.isSafeInteger(gross) || gross <= 0) {
    throw new Error('Gross pay must be a positive whole number of cents')
  }
}

/** An outflow can take back a deposit, as long as that deposit is not itself a reversal. */
async function assertReversible(
  db: SqlRunner,
  outflowAmount: number,
  targetId: string,
  selfId: string,
) {
  if (outflowAmount >= 0) throw new Error('Only an outflow can reverse income')
  if (targetId === selfId) throw new Error('A transaction can’t reverse itself')
  const [target] = await db.query<{
    amount: number
    reverses_id: string | null
    transfer_pair_id: string | null
  }>('SELECT amount, reverses_id, transfer_pair_id FROM transactions WHERE id = ?', [targetId])
  if (!target) throw new Error('The income to reverse was not found')
  if (target.amount <= 0 || target.transfer_pair_id !== null || target.reverses_id !== null) {
    throw new Error('Pick the deposit this takes back')
  }
}

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

/**
 * `keep` is the goals the transaction being edited already spends from, so a line that
 * stays on an archived goal still saves.
 */
async function assertCategoriesExist(
  db: SqlRunner,
  splits: SplitInput[],
  keep: ReadonlySet<string> = new Set(),
) {
  for (const id of new Set(splits.flatMap((s) => (s.categoryId ? [s.categoryId] : [])))) {
    await assertCategoryExists(db, id)
    await assertNotPaymentCategory(db, id)
  }
  for (const { categoryId, goalId } of splits) {
    if (goalId) await assertGoalUsable(db, goalId, categoryId, keep)
  }
}

const goalsOf = (t: Transaction) => new Set(t.splits.flatMap((s) => (s.goalId ? [s.goalId] : [])))

export async function loadTransactions(
  db: SqlRunner,
  where: string,
  params: string[],
): Promise<Transaction[]> {
  const rows = await db.query<TransactionRow & Record<string, never>>(
    `SELECT id, account_id, date, payee, amount, cleared, reconciled, approved, import_id,
       transfer_pair_id, gross_amount, reverses_id,
       (SELECT p.account_id FROM transactions p
         WHERE p.transfer_pair_id = t.transfer_pair_id AND p.id <> t.id) AS transfer_account_id
     FROM transactions t ${where} ORDER BY date DESC, created_at DESC, id DESC`,
    params,
  )
  if (rows.length === 0) return []
  const splits = await db.query<SplitRow & Record<string, never>>(
    `SELECT s.id, s.transaction_id, s.category_id, s.goal_id, s.need_or_want_override, s.amount
     FROM transaction_splits s
     JOIN transactions t ON t.id = s.transaction_id ${where} ORDER BY s.rowid`,
    params,
  )
  const byTransaction = new Map<string, TransactionSplit[]>()
  for (const s of splits) {
    const list = byTransaction.get(s.transaction_id) ?? []
    list.push({
      id: s.id,
      categoryId: s.category_id,
      goalId: s.goal_id,
      needOrWant: s.need_or_want_override,
      amount: s.amount,
    })
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
    approved: r.approved === 1,
    importId: r.import_id,
    transferPairId: r.transfer_pair_id,
    transferAccountId: r.transfer_account_id,
    grossAmount: r.gross_amount,
    reversesId: r.reverses_id,
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
    if (patch.categoryId || patch.goalId) {
      const budgetToTracking =
        partner !== null &&
        (await onBudget(tx, current.accountId)) &&
        !(await onBudget(tx, partner.accountId))
      if (!budgetToTracking) {
        throw new Error('Only the budget side of a transfer to a tracking account takes a category')
      }
      if (patch.categoryId) {
        await assertCategoryExists(tx, patch.categoryId)
        await assertNotPaymentCategory(tx, patch.categoryId)
      }
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
      const categoryId = patch.categoryId === undefined ? only.categoryId : patch.categoryId || null
      // Like on any line, the goal stays only while the category does, unless one is named.
      const goalId =
        patch.goalId !== undefined
          ? patch.goalId || null
          : categoryId === only.categoryId
            ? only.goalId
            : null
      if (goalId) await assertGoalUsable(tx, goalId, categoryId, goalsOf(current))
      await changes.update('transaction_splits', only.id, {
        category_id: categoryId,
        goal_id: categoryId ? goalId : null,
        amount,
      })
    }
    if (partner && patch.amount !== undefined) {
      await changes.update('transactions', partner.id, { amount: -amount })
      const [theirs] = partner.splits
      if (theirs) await changes.update('transaction_splits', theirs.id, { amount: -amount })
    }
    await settleUnits(tx, changes, now(), [current.id, partner?.id])
    return get(tx, current.id)
  }

  return {
    listTransactions(filter = {}) {
      const conditions: string[] = []
      const params: string[] = []
      if (filter.accountId !== undefined) {
        conditions.push('t.account_id = ?')
        params.push(filter.accountId)
      }
      if (filter.unapproved) conditions.push('t.approved = 0')
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      return loadTransactions(adapter, where, params)
    },

    async createTransaction(input) {
      const { accountId, date, payee, cleared, grossAmount, reversesId } = input
      const lines: SplitInput[] = input.splits ?? [
        {
          categoryId: input.categoryId || null,
          goalId: input.goalId,
          needOrWant: input.needOrWant,
          amount: input.amount,
        },
      ]
      assertDate(date)
      assertGross(grossAmount)
      if (input.splits) assertSplits(lines)
      else {
        assertAmount(input.amount)
        if (input.needOrWant) assertNeedOrWant(input.needOrWant)
      }
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
        if (reversesId) await assertReversible(tx, amount, reversesId, id)
        await changes.insert('transactions', {
          id,
          account_id: accountId,
          date,
          payee: cleanPayee(payee),
          amount,
          cleared: flag(cleared ?? false),
          reconciled: 0,
          gross_amount: grossAmount ?? null,
          reverses_id: reversesId || null,
          created_at: at,
        })
        for (const line of lines) {
          await changes.insert('transaction_splits', {
            id: newId(),
            transaction_id: id,
            category_id: line.categoryId || null,
            goal_id: line.categoryId ? line.goalId || null : null,
            need_or_want_override: line.categoryId ? line.needOrWant || null : null,
            amount: line.amount,
            created_at: at,
          })
        }
        await settleIncome(tx, changes, at, [id, reversesId])
        await settleUnits(tx, changes, at, [id])
        return get(tx, id)
      })
    },

    async createTransfer({
      fromAccountId,
      toAccountId,
      date,
      amount,
      categoryId,
      goalId,
      cleared,
    }) {
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
        if (goalId) {
          if (!categoryId) throw new Error('A goal needs its category too')
          await assertGoalUsable(tx, goalId, categoryId)
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
            goal_id: leg.budget && categoryId ? goalId || null : null,
            amount: leg.amount,
            created_at: at,
          })
        }
        await settleUnits(tx, changes, at, ids)
        return [await get(tx, ids[0]!), await get(tx, ids[1]!)]
      })
    },

    async updateTransaction(id, patch) {
      if (patch.date !== undefined) assertDate(patch.date)
      if (patch.amount !== undefined) assertAmount(patch.amount)
      if (patch.needOrWant) assertNeedOrWant(patch.needOrWant)
      assertGross(patch.grossAmount)
      if (patch.splits && (patch.categoryId !== undefined || patch.amount !== undefined)) {
        throw new Error('Change either the splits or the category and amount, not both')
      }
      const amount = patch.splits ? assertSplits(patch.splits) : patch.amount
      return adapter.transaction(async (tx) => {
        const current = await get(tx, id)
        if (current.reconciled) throw new Error('This transaction is reconciled and locked')
        if (current.transferPairId !== null) return updateLeg(tx, current, patch)
        const changes = log(tx)
        const reversesId =
          patch.reversesId === undefined ? current.reversesId : patch.reversesId || null
        if (reversesId) await assertReversible(tx, amount ?? current.amount, reversesId, id)
        await changes.update('transactions', id, {
          date: patch.date ?? current.date,
          payee: patch.payee === undefined ? current.payee : cleanPayee(patch.payee),
          amount: amount ?? current.amount,
          cleared: flag(patch.cleared ?? current.cleared),
          gross_amount: patch.grossAmount === undefined ? current.grossAmount : patch.grossAmount,
          reverses_id: reversesId,
        })
        if (patch.splits) {
          await assertCategoriesExist(tx, patch.splits, goalsOf(current))
          // Lines keep their rows by position so an edit only logs what changed.
          const at = now()
          for (const [i, line] of patch.splits.entries()) {
            const existing = current.splits[i]
            const goalId = line.categoryId ? line.goalId || null : null
            const needOrWant = line.categoryId ? line.needOrWant || null : null
            if (existing) {
              await changes.update('transaction_splits', existing.id, {
                category_id: line.categoryId || null,
                goal_id: goalId,
                need_or_want_override: needOrWant,
                amount: line.amount,
              })
            } else {
              await changes.insert('transaction_splits', {
                id: newId(),
                transaction_id: id,
                category_id: line.categoryId || null,
                goal_id: goalId,
                need_or_want_override: needOrWant,
                amount: line.amount,
                created_at: at,
              })
            }
          }
          for (const extra of current.splits.slice(patch.splits.length)) {
            await changes.delete('transaction_splits', extra.id)
          }
          await settleIncome(tx, changes, now(), [id, current.reversesId, reversesId])
          await settleUnits(tx, changes, now(), [id])
          return get(tx, id)
        }
        const touchesSplit =
          patch.categoryId !== undefined ||
          patch.goalId !== undefined ||
          patch.needOrWant !== undefined ||
          patch.amount !== undefined
        if (touchesSplit) {
          const [only, ...rest] = current.splits
          if (!only || rest.length > 0) {
            throw new Error('Split transactions can’t change category or amount here')
          }
          if (patch.categoryId) {
            await assertCategoryExists(tx, patch.categoryId)
            await assertNotPaymentCategory(tx, patch.categoryId)
          }
          const categoryId =
            patch.categoryId === undefined ? only.categoryId : patch.categoryId || null
          // The goal stays only while the category does, unless the patch names another.
          const goalId =
            patch.goalId !== undefined
              ? patch.goalId || null
              : categoryId === only.categoryId
                ? only.goalId
                : null
          if (goalId) await assertGoalUsable(tx, goalId, categoryId, goalsOf(current))
          // Like the goal, the override stays only while the category does.
          const needOrWant =
            patch.needOrWant !== undefined
              ? patch.needOrWant || null
              : categoryId === only.categoryId
                ? only.needOrWant
                : null
          await changes.update('transaction_splits', only.id, {
            category_id: categoryId,
            goal_id: categoryId ? goalId : null,
            need_or_want_override: categoryId ? needOrWant : null,
            amount: patch.amount ?? only.amount,
          })
        }
        // Only what decides whether a deposit is income, and how much, can move rule allocations.
        const touchesIncome =
          touchesSplit ||
          patch.date !== undefined ||
          patch.payee !== undefined ||
          patch.grossAmount !== undefined ||
          patch.reversesId !== undefined
        if (touchesIncome) {
          await settleIncome(tx, changes, now(), [id, current.reversesId, reversesId])
        }
        // Clearing, dating or re-amounting a dividend moves its units.
        await settleUnits(tx, changes, now(), [id])
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
        if (current.importId !== null) await dismissImport(tx, changes, current.importId, now())
        for (const gone of partner ? [current, partner] : [current]) {
          for (const split of gone.splits) await changes.delete('transaction_splits', split.id)
          await changes.delete('transactions', gone.id)
        }
        // A deposit that is gone gives back what the rules assigned; a deleted reversal
        // gives its deposit's share back.
        await settleIncome(tx, changes, now(), [current.id, current.reversesId])
        // Units a deleted contribution bought go with it.
        await settleUnits(tx, changes, now(), [current.id, partner?.id])
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
