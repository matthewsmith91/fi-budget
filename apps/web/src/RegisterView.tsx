import {
  cents,
  formatCents,
  parseCents,
  type Account,
  type CategoryGroup,
  type Goal,
  type NeedOrWant,
  type SplitInput,
  type Transaction,
  type TransactionSplit,
} from '@budget-fi/core'
import { useState } from 'react'
import { InvestmentDetails } from './InvestmentDetails.tsx'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { money, parseDate, shortDate, todayIso } from './format.ts'
import { Menu } from './Menu.tsx'
import { ReconcileDialog } from './ReconcileDialog.tsx'
import { TransferDialog } from './TransferDialog.tsx'

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
  const goals = useBudgetQuery(() => budget.listGoals())
  const balances = useBudgetQuery(() => budget.getAccountBalances())
  // 'new' is the blank entry row; otherwise the id of the transaction being edited
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [transferring, setTransferring] = useState(false)
  const [reconciling, setReconciling] = useState(false)

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
  const goalName = new Map((goals.data ?? []).map((g) => [g.id, g.name] as const))
  const accountById = new Map(accounts.map((a) => [a.id, a]))
  const payees = [...new Set((transactions.data ?? []).flatMap((t) => (t.payee ? [t.payee] : [])))]
  // Deposits an outflow can take back: income that landed in Ready to Assign.
  const deposits = (transactions.data ?? []).filter(
    (t) =>
      t.amount > 0 &&
      t.approved &&
      !t.transferPairId &&
      !t.reversesId &&
      t.splits.every((s) => !s.categoryId),
  )

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
        <button
          type="button"
          className="secondary"
          disabled={accounts.filter((a) => !a.closed).length < 2}
          onClick={() => setTransferring(true)}
        >
          + Add Transfer
        </button>
        {account && !account.closed && (
          <button type="button" className="secondary" onClick={() => setReconciling(true)}>
            Reconcile
          </button>
        )}
        {account?.type === 'investment' && <InvestmentDetails accountId={account.id} />}
        {account && <AccountMenu account={account} run={run} />}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="table-wrap">
        <table className={editing ? 'register editing' : 'register'}>
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
                transfer={null}
                accounts={scoped.filter((a) => !a.closed)}
                defaultAccountId={accountId ?? scoped.find((a) => !a.closed)?.id ?? ''}
                showAccountColumn={showAccountColumn}
                groups={groups.data ?? []}
                goals={goals.data ?? []}
                payees={payees}
                deposits={deposits}
                onCancel={() => setEditing(null)}
                onSave={(input) =>
                  run(() =>
                    budget.createTransaction({
                      accountId: input.accountId,
                      date: input.date,
                      payee: input.payee,
                      splits: input.splits,
                      grossAmount: input.grossAmount,
                      reversesId: input.reversesId,
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
                  goals={goals.data ?? []}
                  payees={payees}
                  deposits={deposits}
                  onCancel={() => setEditing(null)}
                  transfer={transferInfo(t, accountById)}
                  onSave={async (input) => {
                    // A transfer has no payee or splits; its amount carries to the other leg.
                    const patch = t.transferPairId
                      ? {
                          date: input.date,
                          amount: input.splits[0]!.amount,
                          categoryId: input.splits[0]!.categoryId,
                        }
                      : {
                          date: input.date,
                          payee: input.payee || null,
                          splits: input.splits,
                          grossAmount: input.grossAmount,
                          reversesId: input.reversesId,
                        }
                    await run(() => budget.updateTransaction(t.id, patch))
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
                  <td>
                    {payeeLabel(t, accountById)}
                    {!t.approved && (
                      <>
                        {' '}
                        <a className="tag" href="#/inbox" onClick={(e) => e.stopPropagation()}>
                          New
                        </a>
                      </>
                    )}
                  </td>
                  <td>{categoryLabel(t, categoryName, goalName, accountById)}</td>
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

      {transferring && (
        <TransferDialog
          onClose={() => setTransferring(false)}
          accounts={accounts.filter((a) => !a.closed)}
          defaultFromId={accountId}
        />
      )}
      {account && reconciling && (
        <ReconcileDialog onClose={() => setReconciling(false)} account={account} />
      )}
    </div>
  )
}

const payeeLabel = (t: Transaction, accounts: Map<string, Account>) =>
  t.transferPairId
    ? `Transfer: ${accounts.get(t.transferAccountId ?? '')?.name ?? 'removed account'}`
    : (t.payee ?? '')

/** What the editor needs to know about a transfer leg; null for an ordinary transaction. */
function transferInfo(t: Transaction, accounts: Map<string, Account>) {
  if (!t.transferPairId) return null
  const mine = accounts.get(t.accountId)
  const other = accounts.get(t.transferAccountId ?? '')
  return {
    label: payeeLabel(t, accounts),
    // Only the budget side of a transfer to a tracking account takes a category.
    categoryEditable: !!mine?.onBudget && other !== undefined && !other.onBudget,
  }
}

function categoryLabel(
  t: Transaction,
  names: Map<string, string>,
  goalNames: Map<string, string>,
  accounts: Map<string, Account>,
): string {
  if (t.splits.length > 1) return `Split (${t.splits.length})`
  const account = accounts.get(t.accountId)
  const id = t.splits[0]?.categoryId
  if (id) {
    const name = names.get(id) ?? 'Unknown category'
    const goal = t.splits[0]?.goalId
    return goal ? `${name}: ${goalName(goalNames, goal)}` : name
  }
  if (!account?.onBudget) return ''
  if (t.transferPairId) {
    // Between two budget accounts nothing enters or leaves the budget.
    const other = accounts.get(t.transferAccountId ?? '')
    if (!other || other.onBudget) return ''
  }
  return t.amount > 0 ? 'Inflow: Ready to Assign' : 'Uncategorized'
}

const goalName = (names: Map<string, string>, id: string) => names.get(id) ?? 'Unknown goal'

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
  splits: SplitInput[]
  /** Pre-tax pay of a deposit, for income rules on a gross basis; null clears it. */
  grossAmount: number | null
  /** The deposit this outflow takes back; null for none. */
  reversesId: string | null
}

/** A split line as typed: a category and an amount in either the outflow or inflow box. */
interface Line {
  categoryId: string
  /** A goal of `categoryId` the line is spent from, or ''. */
  goalId: string
  /** Tags the line as a need or a want whatever its category says, or '' to follow the category. */
  needOrWant: NeedOrWant | ''
  outflow: string
  inflow: string
}

const GOAL_PREFIX = 'goal:'

const emptyLine = (): Line => ({
  categoryId: '',
  goalId: '',
  needOrWant: '',
  outflow: '',
  inflow: '',
})

const lineOf = (s: TransactionSplit): Line => ({
  categoryId: s.categoryId ?? '',
  goalId: s.goalId ?? '',
  needOrWant: s.needOrWant ?? '',
  outflow: s.amount < 0 ? plain(-s.amount) : '',
  inflow: s.amount > 0 ? plain(s.amount) : '',
})

/** The signed cents a line holds: 0 when empty, a message when it can't be read. */
function amountOf(line: Line): number | string {
  const out = line.outflow.trim() === '' ? 0 : parseCents(line.outflow)
  const into = line.inflow.trim() === '' ? 0 : parseCents(line.inflow)
  if (out === null || into === null) return 'Enter amounts as dollars, like 42.50'
  if (out < 0 || into < 0) return 'Amounts must be positive; use Inflow for money in'
  return into - out
}

function TransactionRow(props: {
  transaction: Transaction | null
  /** Set when editing one leg of a transfer: no payee, no splits, a category only sometimes. */
  transfer: { label: string; categoryEditable: boolean } | null
  accounts: Account[]
  defaultAccountId: string
  showAccountColumn: boolean
  groups: CategoryGroup[]
  goals: Goal[]
  payees: string[]
  /** Income that an outflow could take back (a reversed paycheck). */
  deposits: Transaction[]
  onCancel: () => void
  onSave: (entry: Entry) => Promise<void>
  onDelete?: () => Promise<void>
}) {
  const { transaction: t } = props
  const [fields, setFields] = useState(() => ({
    accountId: props.defaultAccountId,
    date: shortDate(t?.date ?? todayIso()),
    payee: t?.payee ?? '',
  }))
  const [lines, setLines] = useState<Line[]>(() => (t ? t.splits.map(lineOf) : [emptyLine()]))
  const [split, setSplit] = useState(lines.length > 1)
  const [gross, setGross] = useState(t?.grossAmount ? plain(t.grossAmount) : '')
  const [reversesId, setReversesId] = useState(t?.reversesId ?? '')
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<typeof fields>) => setFields({ ...fields, ...patch })
  const setLine = (i: number, patch: Partial<Line>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const account = props.accounts.find((a) => a.id === fields.accountId)

  const amounts = lines.map(amountOf)
  const total = amounts.reduce<number>((n, a) => n + (typeof a === 'number' ? a : 0), 0)
  // Income rules look at uncategorized inflows, and a reversal is an outflow from the same account.
  const isIncome = !props.transfer && account?.onBudget !== false && total > 0
  const showGross = isIncome && lines.every((l) => !l.categoryId)
  const reversible = props.deposits.filter(
    (d) => d.accountId === fields.accountId && d.id !== t?.id,
  )
  const showReverses =
    !props.transfer &&
    account?.onBudget !== false &&
    total < 0 &&
    (reversible.length > 0 || !!reversesId)

  function toggleSplit() {
    setError(null)
    if (!split) {
      setLines([...lines, emptyLine()])
      return setSplit(true)
    }
    const bad = amounts.find((a) => typeof a === 'string')
    if (bad) return setError(bad as string)
    // Back to one line: the first line's category carries the whole amount.
    setLines([
      {
        categoryId: lines[0]!.categoryId,
        goalId: lines[0]!.goalId,
        needOrWant: lines[0]!.needOrWant,
        outflow: total < 0 ? plain(-total) : '',
        inflow: total > 0 ? plain(total) : '',
      },
    ])
    setSplit(false)
  }

  async function save() {
    setError(null)
    const date = parseDate(fields.date)
    if (!date) return setError('Enter the date like 10/28/2026')
    const bad = amounts.find((a) => typeof a === 'string')
    if (bad) return setError(bad as string)
    const splits: SplitInput[] = lines.map((l, i) => ({
      categoryId: l.categoryId || null,
      goalId: l.goalId || null,
      needOrWant: l.needOrWant || null,
      amount: amounts[i] as number,
    }))
    if (splits.some((s) => s.amount === 0)) {
      return setError(
        split ? 'Every split needs an outflow or an inflow' : 'Enter an outflow or an inflow',
      )
    }
    let grossAmount: number | null = null
    if (showGross && gross.trim() !== '') {
      const parsed = parseCents(gross)
      if (parsed === null || parsed <= 0)
        return setError('Enter gross pay as dollars, like 3100.00')
      grossAmount = parsed
    }
    try {
      await props.onSave({
        accountId: fields.accountId,
        date,
        payee: fields.payee,
        splits,
        grossAmount,
        reversesId: showReverses ? reversesId || null : null,
      })
      if (!t) {
        setFields({ ...fields, payee: '' })
        setLines([emptyLine()])
        setSplit(false)
        setGross('')
        setReversesId('')
      }
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const blankFor = (line: Line) =>
    account?.onBudget === false
      ? '—'
      : line.inflow.trim() !== '' && line.outflow.trim() === ''
        ? 'Inflow: Ready to Assign'
        : 'Uncategorized'
  const label = t ? 'Edit transaction' : 'New transaction'
  const listId = `payees-${t?.id ?? 'new'}`
  const columns = props.showAccountColumn ? 7 : 6

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
      e.preventDefault()
      void save()
    }
    if (e.key === 'Escape') props.onCancel()
  }

  /** A goal option stands for its category plus that goal; a category option clears the goal. */
  const pick = (value: string): Pick<Line, 'categoryId' | 'goalId'> => {
    if (!value.startsWith(GOAL_PREFIX)) return { categoryId: value, goalId: '' }
    const goalId = value.slice(GOAL_PREFIX.length)
    return { categoryId: props.goals.find((g) => g.id === goalId)?.categoryId ?? '', goalId }
  }

  const defaultTag = (categoryId: string) =>
    props.groups.flatMap((g) => g.categories).find((c) => c.id === categoryId)?.needOrWant ===
    'need'
      ? 'need'
      : 'want'

  const categorySelect = (line: Line, i: number, name: string) => (
    <>
      <select
        aria-label={name}
        value={line.goalId ? `${GOAL_PREFIX}${line.goalId}` : line.categoryId}
        disabled={props.transfer !== null && !props.transfer.categoryEditable}
        onChange={(e) => {
          const picked = pick(e.target.value)
          // An override belongs to the category it was chosen for.
          setLine(i, picked.categoryId === line.categoryId ? picked : { ...picked, needOrWant: '' })
        }}
      >
        <option value="">{blankFor(line)}</option>
        {props.groups
          .filter((g) => !g.hidden)
          .map((g) => (
            <optgroup key={g.id} label={g.name}>
              {g.categories
                .filter((c) => !c.creditCardAccountId && (!c.hidden || c.id === line.categoryId))
                .flatMap((c) => [
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>,
                  // Spending from a goal is a planned draw-down of that goal's balance.
                  ...props.goals
                    .filter(
                      (goal) =>
                        goal.categoryId === c.id && (!goal.archived || goal.id === line.goalId),
                    )
                    .map((goal) => (
                      <option key={goal.id} value={`${GOAL_PREFIX}${goal.id}`}>
                        {`\u00a0\u00a0↳ ${goal.name}${goal.archived ? ' (archived)' : ''}`}
                      </option>
                    )),
                ])}
            </optgroup>
          ))}
      </select>
      {line.categoryId && !props.transfer && (
        <select
          className="need-want-select"
          aria-label={`Need or want${name === 'Category' ? '' : name.slice('Category'.length)}`}
          value={line.needOrWant}
          onChange={(e) => setLine(i, { needOrWant: e.target.value as NeedOrWant | '' })}
        >
          <option value="">Default ({defaultTag(line.categoryId)})</option>
          <option value="need">Need</option>
          <option value="want">Want</option>
        </select>
      )}
    </>
  )

  const amountInputs = (line: Line, i: number, suffix: string) => (
    <>
      <td className="num" data-label="Outflow">
        <input
          aria-label={`Outflow${suffix}`}
          inputMode="decimal"
          placeholder="0.00"
          value={line.outflow}
          onChange={(e) => setLine(i, { outflow: e.target.value })}
        />
      </td>
      <td className="num" data-label="Inflow">
        <input
          aria-label={`Inflow${suffix}`}
          inputMode="decimal"
          placeholder="0.00"
          value={line.inflow}
          onChange={(e) => setLine(i, { inflow: e.target.value })}
        />
      </td>
    </>
  )

  return (
    <>
      <tr className="edit-row" aria-label={label} onKeyDown={onKeyDown}>
        <td data-label="Date">
          <input
            aria-label="Date"
            value={fields.date}
            onChange={(e) => set({ date: e.target.value })}
          />
        </td>
        {props.showAccountColumn && (
          <td data-label="Account">
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
        <td data-label="Payee">
          <input
            autoFocus
            aria-label="Payee"
            list={listId}
            value={props.transfer ? props.transfer.label : fields.payee}
            disabled={props.transfer !== null}
            onChange={(e) => set({ payee: e.target.value })}
          />
          <datalist id={listId}>
            {props.payees.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </td>
        {split ? (
          <>
            <td data-label="Category">
              <span className="split-total">Split ({lines.length})</span>
            </td>
            <td className="num" data-label="Outflow">
              {total < 0 ? money(-total) : ''}
            </td>
            <td className="num" data-label="Inflow">
              {total > 0 ? money(total) : ''}
            </td>
          </>
        ) : (
          <>
            <td data-label="Category">{categorySelect(lines[0]!, 0, 'Category')}</td>
            {amountInputs(lines[0]!, 0, '')}
          </>
        )}
        <td />
      </tr>
      {split &&
        lines.map((line, i) => (
          <tr
            key={i}
            className="edit-row split-line"
            aria-label={`Split ${i + 1}`}
            onKeyDown={onKeyDown}
          >
            <td className="split-gap" colSpan={props.showAccountColumn ? 3 : 2} />
            <td data-label="Category">{categorySelect(line, i, `Category ${i + 1}`)}</td>
            {amountInputs(line, i, ` ${i + 1}`)}
            <td className="cleared-col">
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove split ${i + 1}`}
                disabled={lines.length <= 2}
                onClick={() => setLines(lines.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </td>
          </tr>
        ))}
      <tr className="edit-actions">
        <td colSpan={columns}>
          {error && (
            <span className="error" role="alert">
              {error}
            </span>
          )}
          {showGross && (
            <label className="inline-field">
              Gross pay
              <input
                aria-label="Gross pay"
                inputMode="decimal"
                placeholder="optional"
                value={gross}
                onChange={(e) => setGross(e.target.value)}
              />
            </label>
          )}
          {showReverses && (
            <label className="inline-field">
              Takes back
              <select
                aria-label="Takes back the deposit"
                value={reversesId}
                onChange={(e) => setReversesId(e.target.value)}
              >
                <option value="">No deposit</option>
                {reversible.map((d) => (
                  <option key={d.id} value={d.id}>
                    {`${shortDate(d.date)} ${d.payee ?? 'Deposit'} ${money(d.amount)}`}
                  </option>
                ))}
              </select>
            </label>
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
          {split && (
            <button
              type="button"
              className="secondary"
              onClick={() => setLines([...lines, emptyLine()])}
            >
              + Add split
            </button>
          )}
          {!props.transfer && (
            <button type="button" className="secondary" onClick={toggleSplit}>
              {split ? 'Unsplit' : 'Split'}
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
