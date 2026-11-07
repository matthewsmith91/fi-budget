import { type Category, type CategoryBalance, type Goal } from '@budget-fi/core'
import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react'
import { AssignedInput } from './AssignedInput.tsx'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { getCollapsedGroups, setCollapsedGroups } from './device-settings.ts'
import { messageOf } from './errors.ts'
import { fundPercent, fundStatus } from './fund-text.ts'
import { dropTarget, moveNextTo, useDragReorder } from './drag-reorder.ts'
import { holdingWarning } from './goal-text.ts'
import { money, monthLabel, monthOf, shiftMonth, todayIso } from './format.ts'
import { GoalForm, GoalRows } from './GoalRows.tsx'
import { CategorySheet, GroupSheet } from './ManageSheet.tsx'
import {
  categoryFigures,
  loadPeek,
  PeekCells,
  peekFor,
  useMediaQuery,
  WIDE,
  type PeekFigures,
} from './peek.tsx'
import { retirementTag } from './retirement-text.ts'
import { RetirementStatusDialog } from './RetirementStatusDialog.tsx'
import { hrefFor } from './route.ts'
import { Skeleton } from './Skeleton.tsx'

type Run = (fn: () => Promise<unknown>) => Promise<void>

const ZERO: CategoryBalance = { categoryId: '', assigned: 0, activity: 0, available: 0 }

export function BudgetView({ today, month: routeMonth }: { today: Date; month: string | null }) {
  const refresh = useRefresh()
  const thisMonth = monthOf(todayIso(today))
  // The open month lives in the URL, so Back from the register lands on the month you left. A
  // change replaces the history entry: Back leaves the budget instead of stepping through months.
  const month = routeMonth ?? thisMonth
  const setMonth = (next: string) =>
    location.replace(next === thisMonth ? hrefFor.budget : hrefFor.budgetFor(next))
  const groups = useBudgetQuery(() => budget.listCategoryGroups())
  // Tagged with their month: a query keeps its last answer while the next one loads. That answer
  // stays on screen, dimmed and read-only, until this month's arrives, so the table doesn't
  // blank out on every month change; it must never pass for this month's.
  const balances = useBudgetQuery(
    () => budget.getMonthBalances(month).then((rows) => ({ month, rows })),
    [month],
  )
  const readyToAssign = useBudgetQuery(
    () => budget.getReadyToAssign(month).then((amount) => ({ month, amount })),
    [month],
  )
  const income = useBudgetQuery(
    () => budget.getMonthIncome(month).then((amount) => ({ month, amount })),
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
  const averageThrough = month < shiftMonth(thisMonth, -1) ? month : shiftMonth(thisMonth, -1)
  const fundQuery = useBudgetQuery(
    () =>
      budget
        .getEmergencyFund({ month: averageThrough, asOf: month })
        .then((fund) => ({ month, fund })),
    [month, averageThrough],
  )
  const fund = fundQuery.data?.month === month ? fundQuery.data.fund : undefined
  const holdings = useBudgetQuery(() => budget.getAccountHoldings(month), [month])
  // The months either side, read-only, beside the open one. A phone or a shrunk window has no
  // room for them, so it doesn't ask. Clicking one's heading makes it the open month, and so
  // editable.
  const wide = useMediaQuery(WIDE)
  const prevMonth = shiftMonth(month, -1)
  const nextMonth = shiftMonth(month, 1)
  const prevQuery = useBudgetQuery(
    () => (wide ? loadPeek(prevMonth) : Promise.resolve(undefined)),
    [prevMonth, wide],
  )
  const nextQuery = useBudgetQuery(
    () => (wide ? loadPeek(nextMonth) : Promise.resolve(undefined)),
    [nextMonth, wide],
  )
  const prev = wide ? peekFor(prevQuery, prevMonth) : undefined
  const next = wide ? peekFor(nextQuery, nextMonth) : undefined
  const [showHidden, setShowHidden] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(getCollapsedGroups)
  const [addingGroup, setAddingGroup] = useState(false)
  const [addingTo, setAddingTo] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [addingGoalTo, setAddingGoalTo] = useState<string | null>(null)
  const [editingGoal, setEditingGoal] = useState<string | null>(null)
  const [retiring, setRetiring] = useState<Category | null>(null)
  const [managing, setManaging] = useState<{ kind: 'category' | 'group'; id: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  // Dragging a handle reorders groups, or the categories inside one group; every id is sent, so
  // hidden ones keep their place.
  const drag = useDragReorder((dragged, target, after) => {
    if (dragged.kind === 'group') {
      const ids = moveNextTo(
        all.map((g) => g.id),
        dragged.id,
        target,
        after,
      )
      if (ids) void run(() => budget.reorderCategoryGroups(ids))
      return
    }
    const group = all.find((g) => g.id === dragged.scope)
    const ids =
      group &&
      moveNextTo(
        group.categories.map((c) => c.id),
        dragged.id,
        target,
        after,
      )
    if (ids) void run(() => budget.reorderCategories(dragged.scope, ids))
  })
  /** Classes that draw the drop line and dim the row being carried. */
  const dragClass = (kind: 'category' | 'group', id: string) => {
    const parts: string[] = []
    if (drag.dragging?.kind === kind && drag.dragging.id === id) parts.push('drag-source')
    if (drag.over?.kind === kind && drag.over.id === id)
      parts.push(drag.over.after ? 'drop-after' : 'drop-before')
    return parts
  }

  // `haveFigures`: there is something to show. `settled`: it is this month's, so it may be edited.
  const haveFigures = balances.data !== undefined
  const settled = balances.data?.month === month
  const haveGoals = goalBalances.data !== undefined
  const goalsSettled = goalBalances.data?.month === month
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
    (haveFigures && balances.data?.rows.find((b) => b.categoryId === id)) || ZERO
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
  /** A neighbouring month's Assigned and Available added up over `cats`. */
  const sumPeek = (cats: Category[], peek: typeof prev): PeekFigures | undefined =>
    peek &&
    cats.reduce(
      (t, c) => {
        const f = categoryFigures(peek, c.id)!
        return { assigned: t.assigned + f.assigned, available: t.available + f.available }
      },
      { assigned: 0, available: 0 },
    )
  const totals = sum(shown.flatMap((g) => g.categories))
  const shownCategories = shown.flatMap((g) => g.categories)
  // a row that spans the table: the open month's three figures, and two for each neighbour
  const span = wide ? 8 : 4
  const label = monthLabel(month)
  // The same categories the monthly review would list; hidden ones count, a card's payment doesn't.
  const overspent = settled
    ? all
        .flatMap((g) => g.categories)
        .filter((c) => c.creditCardAccountId === null && balanceOf(c.id).available < 0).length
    : 0
  const accountList = accounts.data ?? []
  const warnings = (holdings.data ?? []).flatMap((h) => {
    const text = holdingWarning(
      h,
      accountList.find((a) => a.id === h.accountId)?.name ?? 'An account',
    )
    return text ? [{ id: h.accountId, text }] : []
  })

  function toggle(id: string) {
    // only groups that still exist are kept, so deleted ones don't pile up in storage
    const next = new Set([...collapsed].filter((c) => all.some((g) => g.id === c)))
    if (!next.delete(id)) next.add(id)
    setCollapsed(next)
    setCollapsedGroups(next)
  }

  /** Rejects on failure: the box that asked shows the reason beside itself. */
  function assign(category: Category, delta: number) {
    return write(() =>
      budget.allocate({ month, categoryId: category.id, amount: delta, note: 'Set in budget' }),
    )
  }

  // The column headings stick just under the page header, whose height changes with its banners.
  const stickyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = stickyRef.current
    if (!el) return
    const page = el.parentElement!
    const measure = () => page.style.setProperty('--budget-sticky-h', `${el.offsetHeight}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const managedCategory =
    managing?.kind === 'category'
      ? all.flatMap((g) => g.categories.map((c) => ({ c, g }))).find((x) => x.c.id === managing.id)
      : undefined
  const managedGroup =
    managing?.kind === 'group' ? all.find((g) => g.id === managing.id) : undefined

  return (
    <div className={wide ? 'page page-wide' : 'page'}>
      <div className="budget-sticky" ref={stickyRef}>
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
            {/* always here, so the header doesn't shift when you leave this month */}
            <button
              type="button"
              className="secondary"
              disabled={month === thisMonth}
              onClick={() => setMonth(thisMonth)}
            >
              This month
            </button>
          </div>
          <div className="header-figures">
            <MonthIncome
              amount={income.data?.amount}
              stale={income.data !== undefined && income.data.month !== month}
            />
            <ReadyToAssign
              month={month}
              amount={readyToAssign.data?.amount}
              stale={readyToAssign.data !== undefined && readyToAssign.data.month !== month}
            />
          </div>
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

        {overspent > 0 && (
          <div className="overspent-bar">
            <a className="review-link" href={hrefFor.reviewFor(month)}>
              {overspent} overspent · Review
            </a>
          </div>
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
            onSubmit={(name) =>
              write(async () => {
                const group = await budget.createCategoryGroup({ name })
                // the next thing anyone wants is a category in it
                setAddingTo(group.id)
              })
            }
            onDone={() => setAddingGroup(false)}
          />
        ) : (
          <button type="button" className="secondary" onClick={() => setAddingGroup(true)}>
            + Category Group
          </button>
        )}
      </div>

      <div
        className={
          settled || !haveFigures ? 'table-wrap budget-wrap' : 'table-wrap budget-wrap stale'
        }
        aria-busy={!settled}
      >
        <table className="budget-table">
          <thead>
            {wide && (
              <tr className="peek-months">
                <td />
                <th scope="colgroup" colSpan={2} className="peek-month">
                  <button type="button" className="link" onClick={() => setMonth(prevMonth)}>
                    <span aria-hidden="true">‹ </span>
                    {monthLabel(prevMonth).name}
                    <span className="sr-only"> (read-only, open it to edit)</span>
                  </button>
                </th>
                <th scope="colgroup" colSpan={3} className="open-month">
                  {label.name}
                </th>
                <th scope="colgroup" colSpan={2} className="peek-month">
                  <button type="button" className="link" onClick={() => setMonth(nextMonth)}>
                    {monthLabel(nextMonth).name}
                    <span aria-hidden="true"> ›</span>
                    <span className="sr-only"> (read-only, open it to edit)</span>
                  </button>
                </th>
              </tr>
            )}
            <tr>
              <th scope="col">Category</th>
              {wide && (
                <>
                  <th scope="col" className="num peek">
                    Assigned
                  </th>
                  <th scope="col" className="num peek peek-end">
                    Available
                  </th>
                </>
              )}
              <th scope="col" className="num">
                Assigned
              </th>
              <th scope="col" className="num col-activity">
                Activity
              </th>
              <th scope="col" className="num">
                Available
              </th>
              {wide && (
                <>
                  <th scope="col" className="num peek peek-start">
                    Assigned
                  </th>
                  <th scope="col" className="num peek">
                    Available
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            <tr className="totals-row">
              <td>All categories</td>
              {wide && <PeekCells side="prev" figures={sumPeek(shownCategories, prev)} />}
              <td className="num">{haveFigures ? money(totals.assigned) : <Skeleton />}</td>
              <td className="num col-activity">
                {haveFigures ? money(totals.activity) : <Skeleton />}
              </td>
              <td className="num">{haveFigures ? money(totals.available) : <Skeleton />}</td>
              {wide && <PeekCells side="next" figures={sumPeek(shownCategories, next)} />}
            </tr>
          </tbody>
          {shown.map((group) => {
            const isCollapsed = collapsed.has(group.id)
            const t = sum(group.categories)
            return (
              <tbody
                key={group.id}
                className={[group.hidden && 'hidden-row', ...dragClass('group', group.id)]
                  .filter(Boolean)
                  .join(' ')}
                {...dropTarget('group', group.id)}
              >
                <tr className="group-row">
                  <th scope="rowgroup">
                    <span className="name-cell">
                      <span
                        className="drag-handle"
                        title={`Drag to move ${group.name}`}
                        aria-hidden="true"
                        {...drag.handleProps({ kind: 'group', id: group.id, scope: '' })}
                      >
                        ⠿
                      </span>
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
                        <span className="row-label">{group.name}</span>
                      </button>
                      <button
                        type="button"
                        className="icon-button add-category"
                        aria-label={`Add category to ${group.name}`}
                        title={`Add category to ${group.name}`}
                        onClick={() => {
                          setAddingTo(group.id)
                          if (isCollapsed) toggle(group.id)
                        }}
                      >
                        <span aria-hidden="true">+</span>
                      </button>
                    </span>
                  </th>
                  {wide && <PeekCells side="prev" figures={sumPeek(group.categories, prev)} />}
                  <td className="num">{haveFigures ? money(t.assigned) : <Skeleton />}</td>
                  <td className="num col-activity">
                    {haveFigures ? money(t.activity) : <Skeleton />}
                  </td>
                  <td className="num">{haveFigures ? money(t.available) : <Skeleton />}</td>
                  {wide && <PeekCells side="next" figures={sumPeek(group.categories, next)} />}
                </tr>
                {!isCollapsed &&
                  group.categories.map((c) => {
                    const b = balanceOf(c.id)
                    const tag = retirementTag(c.retirementStatus, c.retirementMultiplier)
                    return (
                      <Fragment key={c.id}>
                        <tr
                          className={[
                            'category-row',
                            c.hidden && 'hidden-row',
                            ...dragClass('category', c.id),
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          {...dropTarget('category', c.id, group.id)}
                        >
                          <th scope="row">
                            <span
                              className="drag-handle"
                              title={`Drag to move ${c.name}`}
                              aria-hidden="true"
                              {...drag.handleProps({ kind: 'category', id: c.id, scope: group.id })}
                            >
                              ⠿
                            </span>
                            <button
                              type="button"
                              className="row-open"
                              aria-haspopup="dialog"
                              onClick={() => setManaging({ kind: 'category', id: c.id })}
                            >
                              <span className="category-name row-label">
                                {c.name}
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
                                {haveFigures && b.activity !== 0 && (
                                  <span className="row-activity">Activity {money(b.activity)}</span>
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
                              <span className="row-chevron" aria-hidden="true">
                                ›
                              </span>
                            </button>
                          </th>
                          {wide && <PeekCells side="prev" figures={categoryFigures(prev, c.id)} />}
                          <td className="num">
                            {haveFigures ? (
                              <AssignedInput
                                label={`Assigned for ${c.name}`}
                                value={b.assigned}
                                disabled={!settled}
                                onCommit={(delta) => assign(c, delta)}
                              />
                            ) : (
                              <Skeleton />
                            )}
                          </td>
                          <td className="num col-activity">
                            {!haveFigures ? (
                              <Skeleton />
                            ) : b.activity !== 0 && c.creditCardAccountId === null ? (
                              <a
                                className="activity-link"
                                href={hrefFor.categoryActivity(c.id, month)}
                                title={`Show ${c.name} transactions for ${label.name} ${label.year}`}
                              >
                                {money(b.activity)}
                                <span className="sr-only">
                                  , show {c.name} transactions for {label.name} {label.year}
                                </span>
                              </a>
                            ) : (
                              money(b.activity)
                            )}
                          </td>
                          <td className="num">
                            {!haveFigures ? (
                              <Skeleton />
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
                          {wide && <PeekCells side="next" figures={categoryFigures(next, c.id)} />}
                        </tr>
                        <GoalRows
                          goals={goalsOf(c.id)}
                          accounts={accountList}
                          balances={goalBalances.data?.rows ?? []}
                          ready={haveGoals}
                          stale={!goalsSettled}
                          span={span}
                          prev={prev}
                          next={next}
                          month={month}
                          editing={editingGoal}
                          onEdit={setEditingGoal}
                          run={run}
                          write={write}
                        />
                        {addingGoalTo === c.id && (
                          <tr className="add-row">
                            <td colSpan={span}>
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
                    <td colSpan={span}>
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
          <div className="empty">
            <p>
              Your budget has no categories yet. Add a category group, then the categories you spend
              on.
            </p>
            {!addingGroup && (
              <button type="button" onClick={() => setAddingGroup(true)}>
                Add category group
              </button>
            )}
          </div>
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
          figures={settled ? balanceOf(managedCategory.c.id) : null}
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
        <GroupSheet
          group={managedGroup}
          all={all}
          onAddCategory={() => {
            setManaging(null)
            setAddingTo(managedGroup.id)
            if (collapsed.has(managedGroup.id)) toggle(managedGroup.id)
          }}
          onClose={() => setManaging(null)}
        />
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

function MonthIncome({ amount, stale }: { amount: number | undefined; stale: boolean }) {
  return (
    <div className={stale ? 'month-income stale' : 'month-income'} aria-busy={stale}>
      <span className="month-income-amount">
        {amount === undefined ? <Skeleton /> : money(amount)}
      </span>
      <span className="month-income-title">Income this month</span>
    </div>
  )
}

function ReadyToAssign({
  amount,
  stale,
  month,
}: {
  amount: number | undefined
  stale: boolean
  month: string
}) {
  if (amount === undefined) {
    return (
      <div className="rta zero" role="status">
        <span className="rta-amount">
          <Skeleton />
        </span>
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
    <div className={stale ? `rta ${kind} stale` : `rta ${kind}`} role="status" aria-busy={stale}>
      <span className="rta-amount">{money(amount)}</span>
      {/* the monthly review is where leftover money is placed and over-assigned money is covered;
          with nothing left to place there is nowhere to go */}
      {amount === 0 ? (
        <span className="rta-title">{title}</span>
      ) : (
        <a className="rta-title rta-link" href={hrefFor.reviewFor(month)}>
          {title}
          <span className="sr-only">, open the monthly review</span>
        </a>
      )}
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
