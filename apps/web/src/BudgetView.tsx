import { type Category, type CategoryBalance, type Goal } from '@budget-fi/core'
import { Fragment, useState, type FormEvent } from 'react'
import { AssignedInput } from './AssignedInput.tsx'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { fundPercent, fundStatus } from './fund-text.ts'
import { holdingWarning } from './goal-text.ts'
import { money, monthLabel, monthOf, shiftMonth, todayIso } from './format.ts'
import { GoalForm, GoalRows } from './GoalRows.tsx'
import { CategorySheet, GroupSheet } from './ManageSheet.tsx'
import { retirementTag } from './retirement-text.ts'
import { RetirementStatusDialog } from './RetirementStatusDialog.tsx'
import { hrefFor } from './route.ts'

type Run = (fn: () => Promise<unknown>) => Promise<void>

const ZERO: CategoryBalance = { categoryId: '', assigned: 0, activity: 0, available: 0 }
const NONE = '—'

export function BudgetView({ today }: { today: Date }) {
  const refresh = useRefresh()
  const [month, setMonth] = useState(() => monthOf(todayIso(today)))
  const groups = useBudgetQuery(() => budget.listCategoryGroups())
  // Tagged with their month: a query keeps its last answer while the next one loads, and the
  // previous month's figures must not pass for this month's.
  const balances = useBudgetQuery(
    () => budget.getMonthBalances(month).then((rows) => ({ month, rows })),
    [month],
  )
  const readyToAssign = useBudgetQuery(
    () => budget.getReadyToAssign(month).then((amount) => ({ month, amount })),
    [month],
  )
  const goals = useBudgetQuery(() => budget.listGoals())
  const goalBalances = useBudgetQuery(
    () => budget.getGoalBalances(month).then((rows) => ({ month, rows })),
    [month],
  )
  const accounts = useBudgetQuery(() => budget.listAccounts())
  // The emergency fund, if the household has one: its target averages Need spending up to the last
  // complete month (or the open month when that is earlier), and its balance is the open month's.
  const averageThrough =
    month < shiftMonth(monthOf(todayIso(today)), -1)
      ? month
      : shiftMonth(monthOf(todayIso(today)), -1)
  const fundQuery = useBudgetQuery(
    () =>
      budget
        .getEmergencyFund({ month: averageThrough, asOf: month })
        .then((fund) => ({ month, fund })),
    [month, averageThrough],
  )
  const fund = fundQuery.data?.month === month ? fundQuery.data.fund : undefined
  const holdings = useBudgetQuery(() => budget.getAccountHoldings(month), [month])
  const [showHidden, setShowHidden] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [addingGroup, setAddingGroup] = useState(false)
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [addingGoalTo, setAddingGoalTo] = useState<string | null>(null)
  const [editingGoal, setEditingGoal] = useState<string | null>(null)
  const [retiring, setRetiring] = useState<Category | null>(null)
  const [managing, setManaging] = useState<{ kind: 'category' | 'group'; id: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const thisMonth = monthOf(todayIso(today))

  const run: Run = async (fn) => {
    setError(null)
    try {
      await fn()
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }
  /** Like `run` but lets the failure reach the form that asked, so it can stay open. */
  const write = async (fn: () => Promise<unknown>) => {
    setError(null)
    await fn()
    refresh()
  }

  // Figures belong to this month only once they have arrived for it.
  const figuresReady = balances.data?.month === month
  const goalsReady = goalBalances.data?.month === month
  const failed = [groups, balances, readyToAssign, goalBalances, goals, accounts].find(
    (q) => q.error,
  )
  const retryAll = () => {
    for (const q of [groups, balances, readyToAssign, goalBalances, goals, accounts]) q.reload()
  }

  const all = groups.data ?? []
  const hiddenCount = all.reduce(
    (n, g) => n + (g.hidden ? g.categories.length : g.categories.filter((c) => c.hidden).length),
    0,
  )
  const shown = all
    .filter((g) => showHidden || !g.hidden)
    .map((g) => ({ ...g, categories: g.categories.filter((c) => showHidden || !c.hidden) }))
  const allGoals = goals.data ?? []
  const archivedCount = allGoals.filter((g) => g.archived).length
  const goalsOf = (categoryId: string): Goal[] =>
    allGoals.filter((g) => g.categoryId === categoryId && (showArchived || !g.archived))
  const balanceOf = (id: string) =>
    (figuresReady && balances.data?.rows.find((b) => b.categoryId === id)) || ZERO
  const sum = (cats: Category[]) =>
    cats.reduce(
      (t, c) => {
        const b = balanceOf(c.id)
        return {
          assigned: t.assigned + b.assigned,
          activity: t.activity + b.activity,
          available: t.available + b.available,
        }
      },
      { assigned: 0, activity: 0, available: 0 },
    )
  const totals = sum(shown.flatMap((g) => g.categories))
  const label = monthLabel(month)
  const accountList = accounts.data ?? []
  const warnings = (holdings.data ?? []).flatMap((h) => {
    const text = holdingWarning(
      h,
      accountList.find((a) => a.id === h.accountId)?.name ?? 'An account',
    )
    return text ? [{ id: h.accountId, text }] : []
  })

  function toggle(id: string) {
    const next = new Set(collapsed)
    if (!next.delete(id)) next.add(id)
    setCollapsed(next)
  }

  async function assign(category: Category, delta: number) {
    await run(() =>
      budget.allocate({ month, categoryId: category.id, amount: delta, note: 'Set in budget' }),
    )
  }

  const managedCategory =
    managing?.kind === 'category'
      ? all.flatMap((g) => g.categories.map((c) => ({ c, g }))).find((x) => x.c.id === managing.id)
      : undefined
  const managedGroup =
    managing?.kind === 'group' ? all.find((g) => g.id === managing.id) : undefined

  return (
    <div className="page">
      <div className="budget-sticky">
        <header className="page-header budget-header">
          <div className="month-nav">
            <button
              type="button"
              className="icon-button"
              aria-label="Previous month"
              onClick={() => setMonth(shiftMonth(month, -1))}
            >
              ‹
            </button>
            <h1>
              {label.name} <span className="muted">{label.year}</span>
            </h1>
            <button
              type="button"
              className="icon-button"
              aria-label="Next month"
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              ›
            </button>
            {month !== thisMonth && (
              <button type="button" className="secondary" onClick={() => setMonth(thisMonth)}>
                This month
              </button>
            )}
          </div>
          <ReadyToAssign
            amount={readyToAssign.data?.month === month ? readyToAssign.data.amount : undefined}
          />
        </header>

        {failed?.error && (
          <div className="banner warn load-error" role="alert">
            <span>Couldn’t load the budget: {messageOf(failed.error)}</span>
            <button type="button" className="secondary" onClick={retryAll}>
              Try again
            </button>
          </div>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>

      {warnings.map((w) => (
        <div key={w.id} className="banner warn" role="status">
          {w.text}
        </div>
      ))}

      <div className="toolbar">
        {addingGroup ? (
          <NameForm
            label="Group name"
            submit="Add group"
            onSubmit={(name) => write(() => budget.createCategoryGroup({ name }))}
            onDone={() => setAddingGroup(false)}
          />
        ) : (
          <button type="button" className="secondary" onClick={() => setAddingGroup(true)}>
            + Category Group
          </button>
        )}
      </div>

      <div className="table-wrap" aria-busy={!figuresReady}>
        <table className="budget-table">
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col" className="num">
                Assigned
              </th>
              <th scope="col" className="num col-activity">
                Activity
              </th>
              <th scope="col" className="num">
                Available
              </th>
            </tr>
            <tr className="totals-row">
              <td>All categories</td>
              <td className="num">{figuresReady ? money(totals.assigned) : NONE}</td>
              <td className="num col-activity">{figuresReady ? money(totals.activity) : NONE}</td>
              <td className="num">{figuresReady ? money(totals.available) : NONE}</td>
            </tr>
          </thead>
          {shown.map((group) => {
            const isCollapsed = collapsed.has(group.id)
            const t = sum(group.categories)
            return (
              <tbody key={group.id} className={group.hidden ? 'hidden-row' : undefined}>
                <tr className="group-row">
                  <th scope="rowgroup">
                    <span className="name-cell">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${group.name}`}
                        aria-expanded={!isCollapsed}
                        onClick={() => toggle(group.id)}
                      >
                        {isCollapsed ? '▸' : '▾'}
                      </button>
                      <button
                        type="button"
                        className="row-open group-name"
                        aria-haspopup="dialog"
                        onClick={() => setManaging({ kind: 'group', id: group.id })}
                      >
                        {group.name}
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Add category to ${group.name}`}
                        onClick={() => {
                          setAddingTo(group.id)
                          if (isCollapsed) toggle(group.id)
                        }}
                      >
                        +
                      </button>
                    </span>
                  </th>
                  <td className="num">{figuresReady ? money(t.assigned) : NONE}</td>
                  <td className="num col-activity">{figuresReady ? money(t.activity) : NONE}</td>
                  <td className="num">{figuresReady ? money(t.available) : NONE}</td>
                </tr>
                {!isCollapsed &&
                  group.categories.map((c) => {
                    const b = balanceOf(c.id)
                    const tag = retirementTag(c.retirementStatus, c.retirementMultiplier)
                    return (
                      <Fragment key={c.id}>
                        <tr className={c.hidden ? 'category-row hidden-row' : 'category-row'}>
                          <th scope="row">
                            <button
                              type="button"
                              className="row-open"
                              aria-haspopup="dialog"
                              onClick={() => setManaging({ kind: 'category', id: c.id })}
                            >
                              <span className="category-name">
                                {c.name}
                                <span className="tag need-want">
                                  {c.needOrWant === 'need' ? 'Need' : 'Want'}
                                </span>
                                {tag && (
                                  <span
                                    className="tag retirement"
                                    title={
                                      c.retirementStatus === 'ends'
                                        ? 'Ends in retirement'
                                        : 'Changes in retirement'
                                    }
                                  >
                                    {tag}
                                  </span>
                                )}
                                {fund?.settings.categoryId === c.id && (
                                  <span className="fund-meter">
                                    <span className="goal-status muted">
                                      {fundStatus(fund).join(' · ')}
                                    </span>
                                    <span
                                      className="goal-bar"
                                      role="progressbar"
                                      aria-label="Emergency fund funded"
                                      aria-valuemin={0}
                                      aria-valuemax={100}
                                      aria-valuenow={fundPercent(fund)}
                                    >
                                      <span style={{ width: `${fundPercent(fund)}%` }} />
                                    </span>
                                  </span>
                                )}
                              </span>
                            </button>
                          </th>
                          <td className="num">
                            {figuresReady ? (
                              <AssignedInput
                                label={`Assigned for ${c.name}`}
                                value={b.assigned}
                                onCommit={(delta) => assign(c, delta)}
                                onInvalid={() =>
                                  setError('Enter the amount as dollars, like 250.00')
                                }
                              />
                            ) : (
                              NONE
                            )}
                          </td>
                          <td className="num col-activity">
                            {figuresReady ? money(b.activity) : NONE}
                          </td>
                          <td className="num">
                            {!figuresReady ? (
                              NONE
                            ) : b.available < 0 && c.creditCardAccountId === null ? (
                              // the monthly review is where overspending gets covered
                              <a className="pill bad" href={hrefFor.reviewFor(month)}>
                                {money(b.available)}
                                <span className="sr-only"> overspent, open the monthly review</span>
                              </a>
                            ) : (
                              <span className={`pill ${tone(b.available)}`}>
                                {money(b.available)}
                              </span>
                            )}
                          </td>
                        </tr>
                        <GoalRows
                          goals={goalsOf(c.id)}
                          accounts={accountList}
                          balances={goalBalances.data?.rows ?? []}
                          ready={goalsReady}
                          month={month}
                          editing={editingGoal}
                          onEdit={setEditingGoal}
                          run={run}
                          onInvalid={() => setError('Enter the amount as dollars, like 250.00')}
                        />
                        {addingGoalTo === c.id && (
                          <tr className="add-row">
                            <td colSpan={4}>
                              <GoalForm
                                label={`New goal in ${c.name}`}
                                accounts={accountList}
                                onSubmit={(input) =>
                                  write(() => budget.createGoal({ categoryId: c.id, ...input }))
                                }
                                onDone={() => setAddingGoalTo(null)}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                {addingTo === group.id && !isCollapsed && (
                  <tr className="add-row">
                    <td colSpan={4}>
                      <NameForm
                        label={`New category in ${group.name}`}
                        submit="Add"
                        onSubmit={(name) =>
                          write(() => budget.createCategory({ groupId: group.id, name }))
                        }
                        onDone={() => setAddingTo(null)}
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            )
          })}
        </table>
        {!groups.loading && !groups.error && shown.length === 0 && (
          <p className="empty">
            Your budget has no categories yet. Add a category group, then the categories you spend
            on.
          </p>
        )}
      </div>

      {archivedCount > 0 && (
        <p className="muted hidden-toggle">
          {archivedCount} archived {archivedCount === 1 ? 'goal' : 'goals'} ·{' '}
          <button type="button" className="link" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? 'Hide them' : 'Show them'}
          </button>
        </p>
      )}

      {hiddenCount > 0 && (
        <p className="muted hidden-toggle">
          {hiddenCount} hidden {hiddenCount === 1 ? 'category' : 'categories'} ·{' '}
          <button type="button" className="link" onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? 'Hide them' : 'Show them'}
          </button>
        </p>
      )}

      {managedCategory && (
        <CategorySheet
          category={managedCategory.c}
          inGroup={managedCategory.g.categories}
          shown={shown.find((g) => g.id === managedCategory.g.id)?.categories ?? []}
          figures={figuresReady ? balanceOf(managedCategory.c.id) : null}
          month={month}
          monthName={`${label.name} ${label.year}`}
          onAddGoal={() => {
            setManaging(null)
            setAddingGoalTo(managedCategory.c.id)
          }}
          onRetirement={() => {
            setManaging(null)
            setRetiring(managedCategory.c)
          }}
          onClose={() => setManaging(null)}
        />
      )}

      {managedGroup && (
        <GroupSheet group={managedGroup} all={all} onClose={() => setManaging(null)} />
      )}

      {retiring && (
        <RetirementStatusDialog
          category={retiring}
          onClose={() => setRetiring(null)}
          onSave={async (retirementStatus, retirementMultiplier) => {
            await budget.updateCategory(retiring.id, { retirementStatus, retirementMultiplier })
            refresh()
          }}
        />
      )}
    </div>
  )
}

const tone = (available: number) => (available < 0 ? 'bad' : available === 0 ? 'zero' : 'good')

function ReadyToAssign({ amount }: { amount: number | undefined }) {
  if (amount === undefined) {
    return (
      <div className="rta zero" role="status">
        <span className="rta-amount">{NONE}</span>
        <span className="rta-title">Loading</span>
      </div>
    )
  }
  const [kind, title] =
    amount > 0
      ? ['good', 'Ready to Assign']
      : amount < 0
        ? ['bad', 'Assigned more than you have']
        : ['zero', 'All money assigned']
  return (
    <div className={`rta ${kind}`} role="status">
      <span className="rta-amount">{money(amount)}</span>
      <span className="rta-title">{title}</span>
    </div>
  )
}

/** A name box that stays open, with what you typed and the reason, when saving fails. */
function NameForm(props: {
  label: string
  submit: string
  onSubmit: (name: string) => Promise<void>
  onDone: () => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await props.onSubmit(name)
    } catch (err) {
      return setError(messageOf(err))
    }
    setName('')
    props.onDone()
  }
  return (
    <form
      className="inline"
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => e.key === 'Escape' && props.onDone()}
    >
      <input
        autoFocus
        aria-label={props.label}
        aria-invalid={error !== null}
        placeholder={props.label}
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <button type="submit">{props.submit}</button>
      <button type="button" className="secondary" onClick={props.onDone}>
        Cancel
      </button>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </form>
  )
}
