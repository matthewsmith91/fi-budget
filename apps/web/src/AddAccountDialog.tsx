import { ACCOUNT_TYPES, parseCents, type AccountType } from '@budget-fi/core'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { todayIso } from './format.ts'
import { hrefFor } from './route.ts'

const TYPE_LABELS: Record<AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit: 'Credit card',
  investment: 'Investment (tracking)',
}

export function AddAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const refresh = useRefresh()
  const [name, setName] = useState('')
  const [type, setType] = useState<AccountType>('checking')
  const [balance, setBalance] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const start = balance.trim() === '' ? 0 : parseCents(balance)
    if (start === null) return setError('Enter the balance as dollars, like 1,250.00')
    try {
      const account = await budget.createAccount({ name, type })
      if (start !== 0) {
        await budget.createTransaction({
          accountId: account.id,
          date: todayIso(),
          payee: 'Starting Balance',
          amount: start,
          cleared: true,
        })
      }
      setName('')
      setBalance('')
      refresh()
      onClose()
      location.hash = hrefFor.account(account.id)
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <dialog ref={dialog} className="dialog" aria-labelledby="add-account-title" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <h2 id="add-account-title">Add Account</h2>
        <label>
          Account name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Account type
          <select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            {ACCOUNT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Current balance
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
          />
          <small className="muted">Use a negative number for a card balance you owe.</small>
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
          <button type="submit">Add account</button>
        </div>
      </form>
    </dialog>
  )
}
