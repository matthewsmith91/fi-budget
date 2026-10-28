import {
  cents,
  formatCents,
  parseCents,
  type Account,
  type CategoryGroup,
  type Transaction,
} from '@budget-fi/core'
import { useState } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { money, parseDate, shortDate, todayIso } from './format.ts'
import { Menu } from './Menu.tsx'

interface Props {
  /** Null shows every account. */
  accountId: string | null
  accounts: Account[]
  accountsLoaded: boolean
  onAddAccount: () => void
}

export function RegisterView({ accountId, accounts, accountsLoaded, onAddAccount }: Props) {
  const refresh = useRefresh()
  const transactions = useBudgetQuery(
    () => budget.listTransactions(accountId ? { accountId } : undefined),
    [accountId],
  )
  const groups = useBudgetQuery(() => budget.listCategoryGroups())
  const balances = useBudgetQuery(() => budget.getAccountBalances())
  // 'new' is the blank entry row; otherwise the id of the transaction being edited
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const account = accountId ? accounts.find((a) => a.id === accountId) : undefined
  const scoped = accountId ? (account ? [account] : []) : accounts.filter((a) => !a.closed)
  const showAccountColumn = accountId === null

  if (accountId && accountsLoaded && !account) {
    return (
      <div className="page">
        <p className="empty">
          That account doesn’t exist. <a href="#/budget">Back to the budget</a>
        </p>
      </div>
    )
  }
  if (accountId === null && accountsLoaded && accounts.length === 0) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>All Accounts</h1>
        </header>
        <p className="empty">
          No accounts yet.{' '}
          <button type="button" className="link" onClick={onAddAccount}>
            Add your first account
          </button>{' '}
          to start recording transactions.
        </p>
      </div>
    )
  }

  const ids = new Set(scoped.map((a) => a.id))
  const mine = (balances.data ?? []).filter((b) => ids.has(b.accountId))
  const cleared = mine.reduce((n, b) => n + b.cleared, 0)
  const working = mine.reduce((n, b) => n + b.balance, 0)

  const categoryName = new Map(
    (groups.data ?? []).flatMap((g) => g.categories.map((c) => [c.id, c.name] as const)),
  )
  const accountById = new Map(accounts.map((a) => [a.id, a]))
  const payees = [...new Set((transactions.data ?? []).flatMap((t) => (t.payee ? [t.payee] : [])))]

  async function run(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const canAdd = scoped.some((a) => !a.closed)

  return (
    <div className="page">
      <header className="page-header register-header">
        <div>
          <h1>{account ? account.name : 'All Accounts'}</h1>
          {account && (
            <span className="muted">
              {account.type}
              {account.onBudget ? '' : ' · tracking'}
              {account.closed ? ' · closed' : ''}
            </span>
          )}
        </div>
        <dl className="balances">
          <div>
            <dd>{money(cleared)}</dd>
            <dt>Cleared</dt>
          </div>
          <span aria-hidden>+</span>
          <div>
            <dd>{money(working - cleared)}</dd>
            <dt>Uncleared</dt>
          </div>
          <span aria-hidden>=</span>
          <div>
            <dd>{money(working)}</dd>
            <dt>Working Balance</dt>
          </div>
        </dl>
      </header>

      <div className="toolbar">
        <button type="button" disabled={!canAdd} onClick={() => setEditing('new')}>
          + Add Transaction
        </button>
        {account && <AccountMenu account={account} run={run} />}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="table-wrap">
        <table className="register">
          <thead>
            <tr>
              <th scope="col">Date</th>
              {showAccountColumn && <th scope="col">Account</th>}
              <th scope="col">Payee</th>
              <th scope="col">Category</th>
              <th scope="col" className="num">
                Outflow
              </th>
              <th scope="col" className="num">
                Inflow
              </th>
              <th scope="col" className="cleared-col">
                <span className="sr-only">Cleared</span>
                <span aria-hidden>C</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {editing === 'new' && (
              <TransactionRow
                key="new"
                transaction={null}
                accounts={scoped.filter((a) => !a.closed)}
                defaultAccountId={accountId ?? scoped.find((a) => !a.closed)?.id ?? ''}
                showAccountColumn={showAccountColumn}
                groups={groups.data ?? []}
                payees={payees}
                onCancel={() => setEditing(null)}
                onSave={(input) =>
                  run(() =>
                    budget.createTransaction({
                      accountId: input.accountId,
                      date: input.date,
                      payee: input.payee,
                      categoryId: input.categoryId,
                      amount: input.amount,
                    }),
                  ).then(() => undefined)
                }
              />
            )}
            {(transactions.data ?? []).map((t) =>
              editing === t.id ? (
                <TransactionRow
                  key={t.id}
                  transaction={t}
                  accounts={accounts}
                  defaultAccountId={t.accountId}
                  showAccountColumn={showAccountColumn}
                  groups={groups.data ?? []}
                  payees={payees}
                  onCancel={() => setEditing(null)}
                  onSave={async (input) => {
                    await run(() =>
                      budget.updateTransaction(t.id, {
                        date: input.date,
                        payee: input.payee || null,
                        ...(t.splits.length === 1
                          ? { categoryId: input.categoryId, amount: input.amount }
                          : {}),
                      }),
                    )
                    setEditing(null)
                  }}
                  onDelete={async () => {
                    if (!confirm('Delete this transaction?')) return
                    await run(() => budget.deleteTransaction(t.id))
                    setEditing(null)
                  }}
                />
              ) : (
                <tr
                  key={t.id}
                  className="txn-row"
                  tabIndex={0}
                  onClick={() => setEditing(t.id)}
                  onKeyDown={(e) =>
                    e.key === 'Enter' && e.target === e.currentTarget && setEditing(t.id)
                  }
                >
                  <td>{shortDate(t.date)}</td>
                  {showAccountColumn && <td>{accountById.get(t.accountId)?.name ?? ''}</td>}
                  <td>{t.payee ?? ''}</td>
                  <td>{categoryLabel(t, categoryName, accountById.get(t.accountId))}</td>
                  <td className="num">{t.amount < 0 ? money(-t.amount) : ''}</td>
                  <td className="num">{t.amount > 0 ? money(t.amount) : ''}</td>
                  <td className="cleared-col">
                    <button
                      type="button"
                      className={t.cleared ? 'clear-toggle on' : 'clear-toggle'}
                      aria-pressed={t.cleared}
                      aria-label={`Cleared: ${t.payee ?? 'transaction'} on ${shortDate(t.date)}`}
                      disabled={t.reconciled}
                      onClick={(e) => {
                        e.stopPropagation()
                        void run(() => budget.updateTransaction(t.id, { cleared: !t.cleared }))
                      }}
                    >
                      {t.reconciled ? '🔒' : 'C'}
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
        {!transactions.loading && transactions.data?.length === 0 && editing !== 'new' && (
          <p className="empty">No transactions yet.</p>
        )}
      </div>
    </div>
  )
}

function categoryLabel(
  t: Transaction,
  names: Map<string, string>,
  account: Account | undefined,
): string {
  if (t.splits.length > 1) return `Split (${t.splits.length})`
  const id = t.splits[0]?.categoryId
  if (id) return names.get(id) ?? 'Unknown category'
  if (!account?.onBudget) return ''
  return t.amount > 0 ? 'Inflow: Ready to Assign' : 'Uncategorized'
}

function AccountMenu({
  account,
  run,
}: {
  account: Account
  run: (fn: () => Promise<unknown>) => Promise<void>
}) {
  return (
    <Menu
      label={`Options for ${account.name}`}
      items={[
        {
          label: 'Rename',
          onSelect: () => {
            const name = prompt('Rename account', account.name)
            if (name !== null) void run(() => budget.updateAccount(account.id, { name }))
          },
        },
        {
          label: account.closed ? 'Reopen' : 'Close',
          onSelect: () =>
            void run(() => budget.updateAccount(account.id, { closed: !account.closed })),
        },
        {
          label: 'Delete',
          onSelect: () => {
            if (!confirm(`Delete ${account.name}?`)) return
            void run(async () => {
              await budget.deleteAccount(account.id)
              location.hash = '#/budget'
            })
          },
        },
      ]}
    />
  )
}

const plain = (amount: number) => formatCents(cents(amount), { symbol: false })

interface Entry {
  accountId: string
  date: string
  payee: string
  categoryId: string | null
  amount: number
}

function TransactionRow(props: {
  transaction: Transaction | null
  accounts: Account[]
  defaultAccountId: string
  showAccountColumn: boolean
  groups: CategoryGroup[]
  payees: string[]
  onCancel: () => void
  onSave: (entry: Entry) => Promise<void>
  onDelete?: () => Promise<void>
}) {
  const { transaction: t } = props
  const isSplit = (t?.splits.length ?? 0) > 1
  const [fields, setFields] = useState(() => ({
    accountId: props.defaultAccountId,
    date: shortDate(t?.date ?? todayIso()),
    payee: t?.payee ?? '',
    categoryId: t?.splits[0]?.categoryId ?? '',
    outflow: t && t.amount < 0 ? plain(-t.amount) : '',
    inflow: t && t.amount > 0 ? plain(t.amount) : '',
  }))
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<typeof fields>) => setFields({ ...fields, ...patch })
  const account = props.accounts.find((a) => a.id === fields.accountId)

  async function save() {
    setError(null)
    const date = parseDate(fields.date)
    if (!date) return setError('Enter the date like 10/28/2026')
    const out = fields.outflow.trim() === '' ? 0 : parseCents(fields.outflow)
    const into = fields.inflow.trim() === '' ? 0 : parseCents(fields.inflow)
    if (out === null || into === null) return setError('Enter amounts as dollars, like 42.50')
    if (out < 0 || into < 0) return setError('Amounts must be positive; use Inflow for money in')
    const amount = isSplit ? t!.amount : into - out
    if (amount === 0) return setError('Enter an outflow or an inflow')
    try {
      await props.onSave({
        accountId: fields.accountId,
        date,
        payee: fields.payee,
        categoryId: fields.categoryId || null,
        amount,
      })
      if (!t) setFields({ ...fields, payee: '', categoryId: '', outflow: '', inflow: '' })
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const incomeOnly = fields.inflow.trim() !== '' && fields.outflow.trim() === ''
  const blank =
    account?.onBudget === false ? '—' : incomeOnly ? 'Inflow: Ready to Assign' : 'Uncategorized'
  const label = t ? 'Edit transaction' : 'New transaction'
  const listId = `payees-${t?.id ?? 'new'}`

  return (
    <>
      <tr
        className="edit-row"
        aria-label={label}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
            e.preventDefault()
            void save()
          }
          if (e.key === 'Escape') props.onCancel()
        }}
      >
        <td>
          <input
            aria-label="Date"
            value={fields.date}
            onChange={(e) => set({ date: e.target.value })}
          />
        </td>
        {props.showAccountColumn && (
          <td>
            <select
              aria-label="Account"
              value={fields.accountId}
              disabled={!!t}
              onChange={(e) => set({ accountId: e.target.value })}
            >
              {props.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </td>
        )}
        <td>
          <input
            autoFocus
            aria-label="Payee"
            list={listId}
            value={fields.payee}
            onChange={(e) => set({ payee: e.target.value })}
          />
          <datalist id={listId}>
            {props.payees.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </td>
        <td>
          <select
            aria-label="Category"
            value={fields.categoryId}
            disabled={isSplit}
            onChange={(e) => set({ categoryId: e.target.value })}
          >
            <option value="">{isSplit ? 'Split' : blank}</option>
            {props.groups
              .filter((g) => !g.hidden)
              .map((g) => (
                <optgroup key={g.id} label={g.name}>
                  {g.categories
                    .filter((c) => !c.hidden || c.id === fields.categoryId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </optgroup>
              ))}
          </select>
        </td>
        <td className="num">
          <input
            aria-label="Outflow"
            inputMode="decimal"
            placeholder="0.00"
            disabled={isSplit}
            value={fields.outflow}
            onChange={(e) => set({ outflow: e.target.value })}
          />
        </td>
        <td className="num">
          <input
            aria-label="Inflow"
            inputMode="decimal"
            placeholder="0.00"
            disabled={isSplit}
            value={fields.inflow}
            onChange={(e) => set({ inflow: e.target.value })}
          />
        </td>
        <td />
      </tr>
      <tr className="edit-actions">
        <td colSpan={props.showAccountColumn ? 7 : 6}>
          {error && (
            <span className="error" role="alert">
              {error}
            </span>
          )}
          <span className="spacer" />
          {props.onDelete && (
            <button
              type="button"
              className="secondary danger"
              onClick={() => void props.onDelete!()}
            >
              Delete
            </button>
          )}
          <button type="button" className="secondary" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()}>
            Save
          </button>
        </td>
      </tr>
    </>
  )
}
