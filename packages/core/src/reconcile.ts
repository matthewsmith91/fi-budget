import { cents } from './money.ts'
import { ADJUSTMENT_PAYEE, type CrudDeps } from './crud.ts'
import { assertDate, loadTransactions, type Transaction } from './transactions.ts'

export { ADJUSTMENT_PAYEE }

export interface ReconciliationStatus {
  accountId: string
  /** Sum of every cleared transaction, reconciled or not: what the bank should say. */
  clearedBalance: number
  /** Sum of the transactions already reconciled and locked. */
  reconciledBalance: number
  /** Cleared transactions a reconciliation would lock. */
  toReconcile: number
  /** Date of the newest reconciled transaction. */
  lastReconciledDate: string | null
}

export interface ReconcileResult {
  /** Posted (cleared and locked) when the bank balance differed from the cleared balance. */
  adjustment: Transaction | null
  /** Transactions locked, the adjustment included. */
  reconciled: number
}

export interface ReconcileApi {
  getReconciliation(accountId: string): Promise<ReconciliationStatus>
  /**
   * Confirms the account's cleared balance against the bank's. If they differ, posts a
   * cleared adjustment for the difference (uncategorized, dated `date`, default today).
   * Then every cleared transaction is locked against edits and deletion.
   */
  reconcileAccount(input: {
    accountId: string
    /** What the bank shows, in integer cents; a card's debt is negative. */
    statementBalance: number
    date?: string
  }): Promise<ReconcileResult>
}

export function reconcileApi({ adapter, newId, now, changes: log }: CrudDeps): ReconcileApi {
  async function status(
    db: Pick<typeof adapter, 'query'>,
    accountId: string,
  ): Promise<ReconciliationStatus> {
    const [account] = await db.query('SELECT 1 AS x FROM accounts WHERE id = ?', [accountId])
    if (!account) throw new Error('Account not found')
    const [row] = await db.query<{
      cleared: number
      reconciled: number
      pending: number
      last: string | null
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN cleared = 1 THEN amount END), 0) AS cleared,
         COALESCE(SUM(CASE WHEN reconciled = 1 THEN amount END), 0) AS reconciled,
         COUNT(CASE WHEN cleared = 1 AND reconciled = 0 THEN 1 END) AS pending,
         MAX(CASE WHEN reconciled = 1 THEN date END) AS last
       FROM transactions WHERE account_id = ?`,
      [accountId],
    )
    return {
      accountId,
      clearedBalance: row!.cleared,
      reconciledBalance: row!.reconciled,
      toReconcile: row!.pending,
      lastReconciledDate: row!.last,
    }
  }

  return {
    getReconciliation: (accountId) => adapter.transaction((tx) => status(tx, accountId)),

    async reconcileAccount({ accountId, statementBalance, date }) {
      try {
        cents(statementBalance)
      } catch {
        throw new Error('Balance must be a whole number of cents')
      }
      const on = date ?? now().slice(0, 10)
      assertDate(on)
      return adapter.transaction(async (tx) => {
        const before = await status(tx, accountId)
        const difference = statementBalance - before.clearedBalance
        const changes = log(tx)
        let adjustmentId: string | null = null
        if (difference !== 0) {
          adjustmentId = newId()
          const at = now()
          await changes.insert('transactions', {
            id: adjustmentId,
            account_id: accountId,
            date: on,
            payee: ADJUSTMENT_PAYEE,
            amount: difference,
            cleared: 1,
            reconciled: 0,
            created_at: at,
          })
          await changes.insert('transaction_splits', {
            id: newId(),
            transaction_id: adjustmentId,
            category_id: null,
            amount: difference,
            created_at: at,
          })
        }
        const locking = await tx.query<{ id: string }>(
          'SELECT id FROM transactions WHERE account_id = ? AND cleared = 1 AND reconciled = 0',
          [accountId],
        )
        for (const { id } of locking) await changes.update('transactions', id, { reconciled: 1 })
        const [adjustment = null] = adjustmentId
          ? await loadTransactions(tx, 'WHERE t.id = ?', [adjustmentId])
          : []
        return { adjustment, reconciled: locking.length }
      })
    },
  }
}
