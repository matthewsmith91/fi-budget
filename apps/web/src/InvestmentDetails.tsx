import {
  INVESTMENT_KINDS,
  INVESTMENT_MODES,
  parseCents,
  taxTypesFor,
  type InvestmentAccount,
  type InvestmentKind,
  type InvestmentMode,
  type InvestmentSettings,
  type TaxType,
} from '@budget-fi/core'
import { useEffect, useRef, useState } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import {
  INVESTMENT_KIND_LABELS,
  INVESTMENT_MODE_LABELS,
  TAX_TYPE_LABELS,
} from './investment-labels.ts'
import { money, shortDate, todayIso } from './format.ts'

/**
 * A gear button for an investment account's tax type, owner and mode, and what it is worth
 * over time. The details open in a dialog, so they stay out of the way of the register.
 */
export function InvestmentDetails({ accountId }: { accountId: string }) {
  const [open, setOpen] = useState(false)
  const accounts = useBudgetQuery(() => budget.listInvestmentAccounts())
  const household = useBudgetQuery(() => budget.getHousehold())
  const account = accounts.data?.find((a) => a.accountId === accountId)
  if (!account) return null
  return (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label={`Investment settings and values for ${account.name}`}
        title="Investment settings and values"
        onClick={() => setOpen(true)}
      >
        ⚙
      </button>
      {open && (
        <InvestmentDialog
          account={account}
          members={household.data?.members ?? []}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/** Mounted only while shown, so it starts fresh every time. */
function InvestmentDialog(props: {
  account: InvestmentAccount
  members: { id: string; displayName: string }[]
  onClose: () => void
}) {
  const { account, onClose } = props
  const dialog = useRef<HTMLDialogElement>(null)
  const refresh = useRefresh()
  const valuations = useBudgetQuery(
    () => budget.listValuations(account.accountId),
    [account.accountId],
  )
  useEffect(() => dialog.current?.showModal(), [])
  const [date, setDate] = useState(todayIso())
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function run(fn: () => Promise<void>) {
    setError(null)
    try {
      await fn()
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const change = (changes: Partial<InvestmentSettings>) =>
    run(async () => {
      await budget.updateInvestmentSettings(account.accountId, changes)
    })

  const record = () =>
    run(async () => {
      const marketValue = parseCents(value)
      if (marketValue === null || marketValue < 0) {
        throw new Error('Enter the value as dollars, like 84,200.00')
      }
      await budget.recordValuation({ accountId: account.accountId, date, marketValue })
      setValue('')
    })

  const latest = account.latestValuation
  return (
    <dialog
      ref={dialog}
      className="dialog tall"
      aria-labelledby="investment-title"
      onClose={onClose}
    >
      <div className="stack">
        <h2 id="investment-title">{account.name}</h2>
        <p>
          {latest ? (
            <>
              <strong>{money(latest.marketValue)}</strong>{' '}
              <span className="muted">
                on {shortDate(latest.date)},{' '}
                {latest.source === 'sync' ? 'from the bank' : 'entered'}
              </span>
            </>
          ) : (
            <span className="muted">No value recorded yet.</span>
          )}
        </p>
        <div className="stack">
          <label>
            Investment type
            <select
              value={account.kind}
              onChange={(e) => void change({ kind: e.target.value as InvestmentKind })}
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
            <select
              value={account.taxType}
              onChange={(e) => void change({ taxType: e.target.value as TaxType })}
            >
              {taxTypesFor(account.kind).map((t) => (
                <option key={t} value={t}>
                  {TAX_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Owner
            <select
              value={account.ownerId ?? ''}
              onChange={(e) => void change({ ownerId: e.target.value || null })}
            >
              <option value="">Joint</option>
              {props.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Mode
            <select
              value={account.mode}
              onChange={(e) => void change({ mode: e.target.value as InvestmentMode })}
            >
              {INVESTMENT_MODES.map((m) => (
                <option key={m} value={m}>
                  {INVESTMENT_MODE_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            void record()
          }}
        >
          <h3>Record a value</h3>
          <label>
            Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <label>
            Market value
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="decimal"
              placeholder="84,200.00"
            />
          </label>
          <div className="row">
            <button type="submit" disabled={!value.trim() || !date}>
              Save value
            </button>
          </div>
          <small className="muted">A day that already has a value is replaced.</small>
        </form>
        {valuations.data && valuations.data.length > 0 && (
          <ul className="plain">
            {valuations.data.map((v) => (
              <li key={v.id} className="row">
                <span>
                  {shortDate(v.date)} · {money(v.marketValue)}{' '}
                  <span className="muted">{v.source === 'sync' ? 'bank' : 'entered'}</span>
                </span>
                <button
                  type="button"
                  className="secondary danger"
                  aria-label={`Delete the value from ${shortDate(v.date)} for ${account.name}`}
                  onClick={() => void run(() => budget.deleteValuation(v.id))}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  )
}
