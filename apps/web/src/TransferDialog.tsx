import { parseCents, type Account } from '@budget-fi/core'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { parseDate, shortDate, todayIso } from './format.ts'

interface Props {
  /** Mounted only while shown, so it starts fresh every time. */
  onClose: () => void
  /** Accounts that can still take transactions. */
  accounts: Account[]
  /** The account the register is showing, if any. */
  defaultFromId: string | null
}

export function TransferDialog({ onClose, accounts, defaultFromId }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const refresh = useRefresh()
  const groups = useBudgetQuery(() => budget.listCategoryGroups())
  const firstFrom = accounts.find((a) => a.id === defaultFromId) ?? accounts[0]
  const [fromId, setFromId] = useState(firstFrom?.id ?? '')
  const [toId, setToId] = useState(accounts.find((a) => a.id !== firstFrom?.id)?.id ?? '')
  const [date, setDate] = useState(() => shortDate(todayIso()))
  const [amount, setAmount] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [cleared, setCleared] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => dialog.current?.showModal(), [])

  const from = accounts.find((a) => a.id === fromId)
  const to = accounts.find((a) => a.id === toId)
  // Money crossing the edge of the budget is spending or income, so it takes a category.
  const crossesBudget = !!from && !!to && from.onBudget !== to.onBudget

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const on = parseDate(date)
    if (!on) return setError('Enter the date like 10/28/2026')
    const cents = parseCents(amount)
    if (cents === null || cents <= 0) return setError('Enter a positive amount, like 250.00')
    try {
      await budget.createTransfer({
        fromAccountId: fromId,
        toAccountId: toId,
        date: on,
        amount: cents,
        categoryId: crossesBudget && categoryId ? categoryId : undefined,
        cleared,
      })
      refresh()
      onClose()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const accountOptions = accounts.map((a) => (
    <option key={a.id} value={a.id}>
      {a.name}
    </option>
  ))

  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="transfer-title" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <h2 id="transfer-title">Add Transfer</h2>
        <label>
          From
          <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
            {accountOptions}
          </select>
        </label>
        <label>
          To
          <select value={toId} onChange={(e) => setToId(e.target.value)}>
            {accountOptions}
          </select>
        </label>
        <label>
          Amount
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </label>
        <label>
          Date
          <input value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        {crossesBudget && (
          <label>
            Category
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Uncategorized</option>
              {(groups.data ?? [])
                .filter((g) => !g.hidden)
                .map((g) => (
                  <optgroup key={g.id} label={g.name}>
                    {g.categories
                      .filter((c) => !c.hidden && !c.creditCardAccountId)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
            </select>
            <small className="muted">
              {from?.onBudget
                ? 'This money leaves the budget, so it counts as spending.'
                : 'This money joins the budget, so it counts as income unless you pick a category.'}
            </small>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={cleared} onChange={(e) => setCleared(e.target.checked)} />{' '}
          Already cleared at the bank
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={accounts.length < 2}>
            Add transfer
          </button>
        </div>
      </form>
    </dialog>
  )
}
