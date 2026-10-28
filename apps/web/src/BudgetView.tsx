import {
  parseCents,
  type Category,
  type CategoryBalance,
  type CategoryGroup,
} from '@budget-fi/core'
import { useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { money, monthLabel, monthOf, shiftMonth, todayIso } from './format.ts'
import { Menu } from './Menu.tsx'

type Run = (fn: () => Promise<unknown>) => Promise<void>

function moved<T>(items: T[], from: number, by: -1 | 1): T[] {
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(from + by, 0, item!)
  return next
}

const ZERO: CategoryBalance = { categoryId: '', assigned: 0, activity: 0, available: 0 }

export function BudgetView({ today }: { today: Date }) {
  const refresh = useRefresh()
  const [month, setMonth] = useState(() => monthOf(todayIso(today)))
  const groups = useBudgetQuery(() => budget.listCategoryGroups())
  const balances = useBudgetQuery(() => budget.getMonthBalances(month), [month])
  const readyToAssign = useBudgetQuery(() => budget.getReadyToAssign(month), [month])
  const [showHidden, setShowHidden] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [addingGroup, setAddingGroup] = useState(false)
  const [addingTo, setAddingTo] = useState<string | null>(null)
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

  const all = groups.data ?? []
  const hiddenCount = all.reduce(
    (n, g) => n + (g.hidden ? g.categories.length : g.categories.filter((c) => c.hidden).length),
    0,
  )
  const shown = all
    .filter((g) => showHidden || !g.hidden)
    .map((g) => ({ ...g, categories: g.categories.filter((c) => showHidden || !c.hidden) }))
  const balanceOf = (id: string) => balances.data?.find((b) => b.categoryId === id) ?? ZERO
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

  return (
    <div className="page">
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
        </div>
        <ReadyToAssign amount={readyToAssign.data} />
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="toolbar">
        {addingGroup ? (
          <NameForm
            label="Group name"
            submit="Add group"
            onSubmit={(name) => run(() => budget.createCategoryGroup({ name }))}
            onDone={() => setAddingGroup(false)}
          />
        ) : (
          <button type="button" className="secondary" onClick={() => setAddingGroup(true)}>
            + Category Group
          </button>
        )}
      </div>

      <div className="table-wrap">
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
              <td className="num">{money(totals.assigned)}</td>
              <td className="num col-activity">{money(totals.activity)}</td>
              <td className="num">{money(totals.available)}</td>
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
                      <span className="group-name">{group.name}</span>
                      <span className="row-actions">
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
                        <GroupMenu group={group} all={all} run={run} />
                      </span>
                    </span>
                  </th>
                  <td className="num">{money(t.assigned)}</td>
                  <td className="num col-activity">{money(t.activity)}</td>
                  <td className="num">{money(t.available)}</td>
                </tr>
                {!isCollapsed &&
                  group.categories.map((c, ci) => {
                    const b = balanceOf(c.id)
                    return (
                      <tr
                        key={c.id}
                        className={c.hidden ? 'category-row hidden-row' : 'category-row'}
                      >
                        <th scope="row">
                          <span className="name-cell">
                            <span className="category-name">{c.name}</span>
                            <span className="row-actions">
                              <CategoryMenu category={c} group={group} index={ci} run={run} />
                            </span>
                          </span>
                        </th>
                        <td className="num">
                          <AssignedInput
                            name={c.name}
                            value={b.assigned}
                            onCommit={(delta) => assign(c, delta)}
                            onInvalid={() => setError('Enter the amount as dollars, like 250.00')}
                          />
                        </td>
                        <td className="num col-activity">{money(b.activity)}</td>
                        <td className="num">
                          <span className={`pill ${tone(b.available)}`}>{money(b.available)}</span>
                        </td>
                      </tr>
                    )
                  })}
                {addingTo === group.id && !isCollapsed && (
                  <tr className="add-row">
                    <td colSpan={4}>
                      <NameForm
                        label={`New category in ${group.name}`}
                        submit="Add"
                        onSubmit={(name) =>
                          run(() => budget.createCategory({ groupId: group.id, name }))
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
        {!groups.loading && shown.length === 0 && (
          <p className="empty">
            Your budget has no categories yet. Add a category group, then the categories you spend
            on.
          </p>
        )}
      </div>

      {hiddenCount > 0 && (
        <p className="muted hidden-toggle">
          {hiddenCount} hidden {hiddenCount === 1 ? 'category' : 'categories'} ·{' '}
          <button type="button" className="link" onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? 'Hide them' : 'Show them'}
          </button>
        </p>
      )}
    </div>
  )
}

const tone = (available: number) => (available < 0 ? 'bad' : available === 0 ? 'zero' : 'good')

function ReadyToAssign({ amount }: { amount: number | undefined }) {
  if (amount === undefined) return <div className="rta zero" aria-hidden />
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

function AssignedInput(props: {
  name: string
  value: number
  onCommit: (delta: number) => void
  onInvalid: () => void
}) {
  const shown = money(props.value)
  return (
    <input
      // a new key resets the field to the stored value after every save
      key={props.value}
      className="assigned-input"
      aria-label={`Assigned for ${props.name}`}
      inputMode="decimal"
      defaultValue={shown}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          e.currentTarget.value = shown
          e.currentTarget.blur()
        }
      }}
      onBlur={(e) => {
        const text = e.currentTarget.value
        if (text === shown) return
        const next = parseCents(text)
        if (next === null) {
          e.currentTarget.value = shown
          return props.onInvalid()
        }
        if (next !== props.value) props.onCommit(next - props.value)
        else e.currentTarget.value = shown
      }}
    />
  )
}

function NameForm(props: {
  label: string
  submit: string
  onSubmit: (name: string) => Promise<void>
  onDone: () => void
}) {
  const [name, setName] = useState('')
  async function submit(e: FormEvent) {
    e.preventDefault()
    await props.onSubmit(name)
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
        placeholder={props.label}
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <button type="submit">{props.submit}</button>
      <button type="button" className="secondary" onClick={props.onDone}>
        Cancel
      </button>
    </form>
  )
}

function GroupMenu(props: { group: CategoryGroup; all: CategoryGroup[]; run: Run }) {
  const { group, all, run } = props
  const reorder = (by: -1 | 1) =>
    run(() =>
      budget.reorderCategoryGroups(
        moved(
          all,
          all.findIndex((g) => g.id === group.id),
          by,
        ).map((g) => g.id),
      ),
    )
  const position = all.findIndex((g) => g.id === group.id)
  return (
    <Menu
      label={`Options for ${group.name}`}
      items={[
        {
          label: 'Rename',
          onSelect: () => {
            const name = prompt('Rename group', group.name)
            if (name !== null) void run(() => budget.updateCategoryGroup(group.id, { name }))
          },
        },
        {
          label: group.hidden ? 'Show' : 'Hide',
          onSelect: () =>
            void run(() => budget.updateCategoryGroup(group.id, { hidden: !group.hidden })),
        },
        { label: 'Move up', disabled: position <= 0, onSelect: () => void reorder(-1) },
        {
          label: 'Move down',
          disabled: position >= all.length - 1,
          onSelect: () => void reorder(1),
        },
        {
          label: 'Delete',
          onSelect: () => {
            if (confirm(`Delete group ${group.name}?`))
              void run(() => budget.deleteCategoryGroup(group.id))
          },
        },
      ]}
    />
  )
}

function CategoryMenu(props: {
  category: Category
  group: CategoryGroup
  index: number
  run: Run
}) {
  const { category: c, group, index, run } = props
  // A card's payment category follows the card, so it can be hidden but not renamed or deleted.
  const managed = c.creditCardAccountId !== null
  // the group here is the filtered view; reorder against the real order
  const reorder = (by: -1 | 1) =>
    run(async () => {
      const real = (await budget.listCategoryGroups()).find((g) => g.id === group.id)
      if (!real) return
      const from = real.categories.findIndex((x) => x.id === c.id)
      await budget.reorderCategories(
        group.id,
        moved(real.categories, from, by).map((x) => x.id),
      )
    })
  return (
    <Menu
      label={`Options for ${c.name}`}
      items={[
        ...(managed
          ? []
          : [
              {
                label: 'Rename',
                onSelect: () => {
                  const name = prompt('Rename category', c.name)
                  if (name !== null) void run(() => budget.updateCategory(c.id, { name }))
                },
              },
            ]),
        {
          label: c.needOrWant === 'need' ? 'Mark as want' : 'Mark as need',
          onSelect: () =>
            void run(() =>
              budget.updateCategory(c.id, {
                needOrWant: c.needOrWant === 'need' ? 'want' : 'need',
              }),
            ),
        },
        {
          label: c.hidden ? 'Show' : 'Hide',
          onSelect: () => void run(() => budget.updateCategory(c.id, { hidden: !c.hidden })),
        },
        { label: 'Move up', disabled: index === 0, onSelect: () => void reorder(-1) },
        {
          label: 'Move down',
          disabled: index === group.categories.length - 1,
          onSelect: () => void reorder(1),
        },
        ...(managed
          ? []
          : [
              {
                label: 'Delete',
                onSelect: () => {
                  if (confirm(`Delete ${c.name}?`)) void run(() => budget.deleteCategory(c.id))
                },
              },
            ]),
      ]}
    />
  )
}
