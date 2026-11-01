import {
  ACCOUNT_TYPES,
  cents,
  DEFAULT_INVESTMENT_SETTINGS,
  INVESTMENT_KINDS,
  INVESTMENT_MODES,
  formatCents,
  parseCents,
  taxTypeFor,
  taxTypesFor,
  type Account,
  type AccountType,
  type InvestmentKind,
  type InvestmentMode,
  type TaxType,
} from '@budget-fi/core'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { bankApi, type ExternalAccount } from './bank.ts'
import { daysThisMonth, openFromBank, openingBalance, unlinkedBankAccounts } from './bank-open.ts'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { todayIso } from './format.ts'
import { useAsync } from './hooks.ts'
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
  const mappings = useBudgetQuery(() => budget.listAccountMappings())
  const [error, setError] = useState<string | null>(null)
  // The server is optional, so a missing one just means no bank option; it is only asked when
  // the dialog is open, not on every page load.
  const links = useAsync(() => (open ? bankApi.links() : Promise.resolve([])), [open])
  const [bank, setBank] = useState<{
    loading: boolean
    accounts: ExternalAccount[] | null
    error: string | null
  }>({ loading: false, accounts: null, error: null })
  const [bankId, setBankId] = useState('')
  // An account made by a submit whose bank step then failed: pressing the button again
  // finishes that account instead of adding a second one.
  const created = useRef<Account | null>(null)
  const [finishing, setFinishing] = useState(false)

  useEffect(() => {
    const el = dialog.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  function reset() {
    created.current = null
    setFinishing(false)
    setBankId('')
    setBank({ loading: false, accounts: null, error: null })
  }

  /** One request per linked bank: balances and this month's transactions together. */
  async function loadBank() {
    setBank({ loading: true, accounts: null, error: null })
    const results = await Promise.all(
      (links.data ?? []).map((l) =>
        bankApi.fetchTransactions(l.id, daysThisMonth(todayIso())).catch((err: unknown) => ({
          linkId: l.id,
          ok: false as const,
          error: messageOf(err),
        })),
      ),
    )
    const failed = results.find((r) => !r.ok)
    setBank({
      loading: false,
      accounts: results.flatMap((r) => (r.ok ? r.accounts : [])),
      error: failed && !failed.ok ? failed.error : null,
    })
  }

  const choices = unlinkedBankAccounts(bank.accounts ?? [], mappings.data ?? [])
  const linked = choices.find((a) => a.id === bankId)
  // Imported transactions count in the balance, so the account opens at what the bank held
  // before them; an investment account is just valued at the bank's balance.
  const fromBank = linked ? (type === 'investment' ? linked.balance : openingBalance(linked)) : null

  function pickBank(id: string) {
    setBankId(id)
    const picked = choices.find((a) => a.id === id)
    if (picked && !name.trim()) setName(picked.org ? `${picked.org} · ${picked.name}` : picked.name)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const start = linked || balance.trim() === '' ? 0 : parseCents(balance)
    if (start === null) return setError('Enter the balance as dollars, like 1,250.00')
    try {
      const account =
        created.current ??
        (created.current = await budget.createAccount({
          name,
          type,
          investment:
            type === 'investment' ? { kind, taxType, ownerId: ownerId || null, mode } : undefined,
        }))
      if (linked) {
        setFinishing(true)
        await openFromBank(budget, account, linked, todayIso())
      } else if (start !== 0) {
        await budget.createTransaction({
          accountId: account.id,
          date: todayIso(),
          payee: 'Starting Balance',
          amount: start,
          cleared: true,
        })
      }
      reset()
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
      refresh()
      setError(
        created.current
          ? `“${created.current.name}” was added, but bringing in the bank’s figures failed: ${messageOf(err)} Try again to finish.`
          : messageOf(err),
      )
    }
  }

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="add-account-title"
      onClose={() => {
        reset()
        onClose()
      }}
    >
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
        {(links.data?.length ?? 0) > 0 && (
          <div className="stack">
            {bank.accounts === null ? (
              <div className="row">
                <button
                  type="button"
                  className="secondary"
                  disabled={bank.loading}
                  onClick={() => void loadBank()}
                >
                  {bank.loading ? 'Asking your bank…' : 'Fill in from my bank'}
                </button>
              </div>
            ) : (
              <label>
                Bank account
                <select value={bankId} onChange={(e) => pickBank(e.target.value)}>
                  <option value="">None, enter it myself</option>
                  {choices.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.org ? `${a.org} · ${a.name}` : a.name} · {formatCents(cents(a.balance))}
                    </option>
                  ))}
                </select>
                {choices.length === 0 && (
                  <small className="muted">Every bank account is already linked.</small>
                )}
              </label>
            )}
            {bank.error && (
              <p className="error" role="alert">
                {bank.error}
              </p>
            )}
          </div>
        )}
        <label>
          {linked
            ? type === 'investment'
              ? 'Current value'
              : 'Starting balance'
            : 'Current balance'}
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={fromBank === null ? balance : formatCents(cents(fromBank))}
            readOnly={linked !== undefined}
            onChange={(e) => setBalance(e.target.value)}
          />
          {linked ? (
            <small className="muted">
              {type === 'investment'
                ? 'Taken from your bank.'
                : `Worked out from your bank so the account ends on ${formatCents(cents(linked.balance))} once this month’s ${linked.transactions.length} transaction${linked.transactions.length === 1 ? '' : 's'} come into the inbox.`}
            </small>
          ) : (
            <small className="muted">Use a negative number for a card balance you owe.</small>
          )}
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
          <button type="submit">{finishing ? 'Finish linking' : 'Add account'}</button>
        </div>
      </form>
    </dialog>
  )
}
