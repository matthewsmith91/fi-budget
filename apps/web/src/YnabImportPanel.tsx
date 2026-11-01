import {
  ACCOUNT_TYPES,
  cents,
  formatCents,
  type Account,
  type DateOrder,
  type YnabImportResult,
  type YnabPreview,
} from '@budget-fi/core'
import { useState } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { defaultChoice, toChoice, type Choice } from './ynab-choices.ts'

const TYPE_LABEL = {
  checking: 'Checking',
  savings: 'Savings',
  credit: 'Credit card',
  investment: 'Investment (tracking)',
} as const

const ORDER_LABEL: Record<DateOrder, string> = {
  MDY: 'Month/Day/Year (10/25/2026)',
  DMY: 'Day/Month/Year (25/10/2026)',
  YMD: 'Year-Month-Day (2026-10-25)',
}

const money = (n: number) => formatCents(cents(n))

/**
 * One-time import of YNAB history from its "Export Budget Data" files. Reads and previews
 * first; nothing changes until the accounts are chosen and Import is pressed.
 */
export function YnabImportPanel() {
  const refresh = useRefresh()
  const accounts = useBudgetQuery(() => budget.listAccounts())
  const [files, setFiles] = useState<{ register: string; budget?: string } | null>(null)
  const [order, setOrder] = useState<DateOrder | undefined>()
  const [preview, setPreview] = useState<YnabPreview | null>(null)
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [result, setResult] = useState<YnabImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(fn: () => Promise<void>) {
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const readPreview = (next: { register: string; budget?: string }, dateOrder?: DateOrder) =>
    run(async () => {
      const p = await budget.previewYnabImport({ ...next, dateOrder })
      setFiles(next)
      setOrder(p.dateOrder)
      setPreview(p)
      setChoices((old) =>
        Object.fromEntries(p.accounts.map((a) => [a.name, old[a.name] ?? defaultChoice(a)])),
      )
    })

  const choose = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    const register = data.get('register')
    const budgetFile = data.get('budget')
    if (!(register instanceof File) || register.size === 0) return setError('Choose Register.csv.')
    void (async () => {
      setResult(null)
      await readPreview({
        register: await register.text(),
        budget:
          budgetFile instanceof File && budgetFile.size > 0 ? await budgetFile.text() : undefined,
      })
    })()
  }

  const decisions = preview?.accounts.map((a) => toChoice(choices[a.name]!)) ?? []
  const ready = preview !== null && decisions.every((d) => d !== null)

  const doImport = () =>
    run(async () => {
      if (!files || !preview || !ready) return
      const picked = Object.fromEntries(preview.accounts.map((a, i) => [a.name, decisions[i]!]))
      setResult(await budget.importYnab({ ...files, dateOrder: order, accounts: picked }))
      setPreview(null)
      setFiles(null)
      refresh()
    })

  return (
    <section className="card">
      <h2>Import from YNAB</h2>
      <p className="muted">
        Bring your history over once. In YNAB choose your budget name → Export Budget Data, then
        pick <code>Register.csv</code> (every transaction) and <code>Budget.csv</code> (called{' '}
        <code>Plan.csv</code> in newer exports; what you assigned each month; optional, but without
        it Ready to Assign starts as all your income). Do this before connecting your bank, so
        fetched transactions can be matched to what is already here. Export a backup first: an
        import can’t be undone.
      </p>

      {!result && (
        <form className="stack" onSubmit={choose}>
          <label>
            Register.csv
            <input name="register" type="file" accept=".csv,text/csv" />
          </label>
          <label>
            Budget.csv (optional)
            <input name="budget" type="file" accept=".csv,text/csv" />
          </label>
          <div className="row">
            <button type="submit" disabled={busy}>
              Read files
            </button>
          </div>
        </form>
      )}

      {preview && files && (
        <div className="stack">
          <p>
            {preview.transactions} transactions
            {preview.splitTransactions > 0 && ` (${preview.splitTransactions} split)`},{' '}
            {preview.transfers} {preview.transfers === 1 ? 'transfer' : 'transfers'} between
            accounts, {preview.categories} categories
            {preview.newCategories < preview.categories && ` (${preview.newCategories} new)`},{' '}
            {preview.allocations} monthly assignments over {preview.months}{' '}
            {preview.months === 1 ? 'month' : 'months'}, from {preview.first} to {preview.last}.
          </p>
          {preview.ambiguousDates && (
            <label>
              Every date here could be read two ways. Which is right?
              <select
                value={order}
                disabled={busy}
                onChange={(e) => void readPreview(files, e.target.value as DateOrder)}
              >
                {(Object.keys(ORDER_LABEL) as DateOrder[]).map((o) => (
                  <option key={o} value={o}>
                    {ORDER_LABEL[o]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <table>
            <thead>
              <tr>
                <th scope="col">YNAB account</th>
                <th scope="col" className="num">
                  Balance
                </th>
                <th scope="col">Goes to</th>
              </tr>
            </thead>
            <tbody>
              {preview.accounts.map((a) => (
                <AccountRow
                  key={a.name}
                  preview={a}
                  choice={choices[a.name]!}
                  accounts={(accounts.data ?? []).filter((x) => !x.closed)}
                  disabled={busy}
                  onChange={(c) => setChoices((all) => ({ ...all, [a.name]: c }))}
                />
              ))}
            </tbody>
          </table>
          {preview.warnings.map((w) => (
            <p key={w} className="muted">
              {w}
            </p>
          ))}
          <div className="row">
            <button type="button" disabled={busy || !ready} onClick={() => void doImport()}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        </div>
      )}

      {result && <Outcome result={result} onAgain={() => setResult(null)} />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function AccountRow(props: {
  preview: YnabPreview['accounts'][number]
  choice: Choice
  accounts: Account[]
  disabled: boolean
  onChange: (choice: Choice) => void
}) {
  const { preview: a, choice: c } = props
  const set = (patch: Partial<Choice>) => props.onChange({ ...c, ...patch })
  return (
    <tr>
      <td>
        {a.name} <span className="muted">({a.transactions})</span>
      </td>
      <td className="num">{money(a.balance)}</td>
      <td>
        <select
          aria-label={`Where ${a.name} goes`}
          value={c.mode === 'existing' ? c.accountId : 'new'}
          disabled={props.disabled}
          onChange={(e) =>
            e.target.value === 'new'
              ? set({ mode: 'create' })
              : set({ mode: 'existing', accountId: e.target.value })
          }
        >
          <option value="new">A new account</option>
          {props.accounts.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        {c.mode === 'create' && (
          <>
            {' '}
            <select
              aria-label={`Type of the new ${a.name} account`}
              value={c.type}
              disabled={props.disabled}
              onChange={(e) => set({ type: e.target.value as Choice['type'] })}
            >
              {ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>{' '}
            <label>
              <input
                type="checkbox"
                checked={c.type !== 'investment' && c.onBudget}
                disabled={props.disabled || c.type === 'investment'}
                onChange={(e) => set({ onBudget: e.target.checked })}
              />{' '}
              On budget
            </label>
          </>
        )}
        {c.mode === 'existing' && a.match?.accountId === c.accountId && a.match.hasTransactions && (
          <span className="muted"> It already has transactions; they would double up.</span>
        )}
      </td>
    </tr>
  )
}

function Outcome({ result, onAgain }: { result: YnabImportResult; onAgain: () => void }) {
  return (
    <div className="stack" role="status">
      <p>
        Imported {result.transactions} transactions
        {result.splitTransactions > 0 && ` (${result.splitTransactions} split)`}, {result.transfers}{' '}
        {result.transfers === 1 ? 'transfer' : 'transfers'}, {result.allocations} monthly
        assignments, {result.accountsCreated} new accounts and {result.categoriesCreated} new
        categories.
      </p>
      {result.mismatchCount === 0 && result.allocations > 0 && (
        <p>Every category matches YNAB’s Budget.csv for the months you exported.</p>
      )}
      {result.mismatchCount > 0 && (
        <>
          <p className="error">
            {result.mismatchCount}{' '}
            {result.mismatchCount === 1 ? 'figure differs' : 'figures differ'} from YNAB’s
            Budget.csv. Credit card overspending and categories you changed after exporting are the
            usual causes.
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Category</th>
                <th scope="col">Figure</th>
                <th scope="col" className="num">
                  YNAB
                </th>
                <th scope="col" className="num">
                  Here
                </th>
              </tr>
            </thead>
            <tbody>
              {result.mismatches.slice(0, 15).map((m) => (
                <tr key={`${m.month}${m.category}${m.field}`}>
                  <td>{m.month}</td>
                  <td>{m.category}</td>
                  <td>{m.field}</td>
                  <td className="num">{money(m.ynab)}</td>
                  <td className="num">{money(m.ours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {result.warnings.map((w) => (
        <p key={w} className="muted">
          {w}
        </p>
      ))}
      <div className="row">
        <a href="#/">See your budget</a>
        <button type="button" className="secondary" onClick={onAgain}>
          Done
        </button>
      </div>
    </div>
  )
}
