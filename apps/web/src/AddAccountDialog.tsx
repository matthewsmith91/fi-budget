import {
  ACCOUNT_TYPES,
  DEFAULT_INVESTMENT_SETTINGS,
  INVESTMENT_KINDS,
  INVESTMENT_MODES,
  parseCents,
  taxTypeFor,
  taxTypesFor,
  type AccountType,
  type InvestmentKind,
  type InvestmentMode,
  type TaxType,
} from '@budget-fi/core'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { todayIso } from './format.ts'
import {
  INVESTMENT_KIND_LABELS,
  INVESTMENT_MODE_LABELS,
  TAX_TYPE_LABELS,
} from './investment-labels.ts'
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
  const [kind, setKind] = useState<InvestmentKind>(DEFAULT_INVESTMENT_SETTINGS.kind)
  const [taxType, setTaxType] = useState<TaxType>(DEFAULT_INVESTMENT_SETTINGS.taxType)
  const [ownerId, setOwnerId] = useState('')
  const [mode, setMode] = useState<InvestmentMode>(DEFAULT_INVESTMENT_SETTINGS.mode)
  const household = useBudgetQuery(() => budget.getHousehold())
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
      const account = await budget.createAccount({
        name,
        type,
        investment:
          type === 'investment' ? { kind, taxType, ownerId: ownerId || null, mode } : undefined,
      })
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
      setKind(DEFAULT_INVESTMENT_SETTINGS.kind)
      setTaxType(DEFAULT_INVESTMENT_SETTINGS.taxType)
      setOwnerId('')
      setMode(DEFAULT_INVESTMENT_SETTINGS.mode)
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
        {type === 'investment' && (
          <>
            <label>
              Investment type
              <select
                value={kind}
                onChange={(e) => {
                  const next = e.target.value as InvestmentKind
                  setKind(next)
                  setTaxType(taxTypeFor(next, taxType))
                }}
              >
                {INVESTMENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {INVESTMENT_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tax type
              <select value={taxType} onChange={(e) => setTaxType(e.target.value as TaxType)}>
                {taxTypesFor(kind).map((t) => (
                  <option key={t} value={t}>
                    {TAX_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Owner
              <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                <option value="">Joint</option>
                {(household.data?.members ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Mode
              <select value={mode} onChange={(e) => setMode(e.target.value as InvestmentMode)}>
                {INVESTMENT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {INVESTMENT_MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
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
