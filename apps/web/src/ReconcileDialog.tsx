import { parseCents, type Account } from '@budget-fi/core'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { money, shortDate } from './format.ts'

/** Mounted only while shown, so it starts fresh every time. */
export function ReconcileDialog(props: { onClose: () => void; account: Account }) {
  const { onClose, account } = props
  const dialog = useRef<HTMLDialogElement>(null)
  const refresh = useRefresh()
  const status = useBudgetQuery(() => budget.getReconciliation(account.id), [account.id])
  const [statement, setStatement] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => dialog.current?.showModal(), [])

  const cleared = status.data?.clearedBalance ?? 0
  const typed = statement.trim() === '' ? null : parseCents(statement)
  const difference = typed === null ? null : typed - cleared

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (typed === null) return setError('Enter the balance your bank shows, like 1,250.00')
    try {
      const result = await budget.reconcileAccount({
        accountId: account.id,
        statementBalance: typed,
      })
      refresh()
      setDone(
        result.adjustment
          ? `Reconciled with an adjustment of ${money(result.adjustment.amount)}.`
          : 'Reconciled. Your balance matches the bank.',
      )
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="reconcile-title" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <h2 id="reconcile-title">Reconcile {account.name}</h2>
        {done ? (
          <>
            <p role="status">{done}</p>
            <div className="dialog-actions">
              <button type="button" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Cleared balance: <strong>{money(cleared)}</strong>
              {status.data?.lastReconciledDate && (
                <small className="muted">
                  {' '}
                  · last reconciled through {shortDate(status.data.lastReconciledDate)}
                </small>
              )}
            </p>
            <label>
              Balance at your bank
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={statement}
                onChange={(e) => setStatement(e.target.value)}
                autoFocus
              />
              <small className="muted">Use a negative number for a card balance you owe.</small>
            </label>
            {difference === 0 && (
              <p role="status">They match. Reconciling locks the cleared transactions.</p>
            )}
            {difference !== null && difference !== 0 && (
              <p role="status">
                They differ by <strong>{money(difference)}</strong>. Reconciling posts an adjustment
                for that amount and locks the cleared transactions. Mark anything that has cleared
                first if the difference is just a missing check mark.
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="submit">
                {difference === null || difference === 0
                  ? 'Reconcile'
                  : 'Reconcile with adjustment'}
              </button>
            </div>
          </>
        )}
      </form>
    </dialog>
  )
}
