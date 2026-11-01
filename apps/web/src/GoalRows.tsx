import {
  cents,
  formatCents,
  parseCents,
  type Account,
  type Goal,
  type GoalBalance,
} from '@budget-fi/core'
import { useState, type FormEvent } from 'react'
import { AssignedInput } from './AssignedInput.tsx'
import { budget } from './client.ts'
import { useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { goalStatus } from './goal-text.ts'
import { money } from './format.ts'
import { Menu } from './Menu.tsx'
import { goalFigures, PeekCells, type Peek } from './peek.tsx'
import { Skeleton } from './Skeleton.tsx'

type Run = (fn: () => Promise<unknown>) => Promise<void>

const tone = (available: number) => (available < 0 ? 'bad' : available === 0 ? 'zero' : 'good')

/** Name, target and optional date: used to add a goal and to edit one. */
export function GoalForm(props: {
  label: string
  goal?: Goal
  accounts: Account[]
  onSubmit: (input: {
    name: string
    targetAmount: number
    targetDate: string | null
    heldInAccountId: string | null
  }) => Promise<void>
  onDone: () => void
}) {
  const { goal } = props
  const [name, setName] = useState(goal?.name ?? '')
  const [target, setTarget] = useState(
    goal ? formatCents(cents(goal.targetAmount), { symbol: false }) : '',
  )
  const [date, setDate] = useState(goal?.targetDate ?? '')
  const [heldIn, setHeldIn] = useState(goal?.heldInAccountId ?? '')
  // Only an open budget account can hold savings; a goal keeps the one it already has.
  const holders = props.accounts.filter(
    (a) => a.id === goal?.heldInAccountId || (a.onBudget && a.type !== 'credit' && !a.closed),
  )
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const targetAmount = parseCents(target)
    if (targetAmount === null || targetAmount <= 0) {
      return setError('Enter the target as dollars, like 1200.00')
    }
    setError(null)
    try {
      await props.onSubmit({
        name,
        targetAmount,
        targetDate: date || null,
        heldInAccountId: heldIn || null,
      })
    } catch (err) {
      // stay open, with what was typed
      return setError(messageOf(err))
    }
    props.onDone()
  }

  return (
    <form
      className="inline goal-form"
      aria-label={props.label}
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => e.key === 'Escape' && props.onDone()}
    >
      <input
        autoFocus
        aria-label="Goal name"
        placeholder="Goal name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <input
        aria-label="Target amount"
        placeholder="Target, e.g. 1200.00"
        inputMode="decimal"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        required
      />
      <input
        type="date"
        aria-label="Target date (optional)"
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      <select
        aria-label="Held in account (optional)"
        value={heldIn}
        onChange={(e) => setHeldIn(e.target.value)}
      >
        <option value="">Not held in an account</option>
        {holders.map((a) => (
          <option key={a.id} value={a.id}>
            Held in {a.name}
          </option>
        ))}
      </select>
      <button type="submit">{goal ? 'Save' : 'Add goal'}</button>
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

/** The rows of one category's goals, to sit right under the category's own row. */
export function GoalRows(props: {
  goals: Goal[]
  accounts: Account[]
  balances: GoalBalance[]
  /** False until some balances have arrived. */
  ready: boolean
  /** True while `balances` is still last month's: shown dimmed, and not editable. */
  stale: boolean
  /** How many columns a full-width row spans. */
  span: number
  /** The months either side, when they are shown: read-only figures. */
  prev: Peek | undefined
  next: Peek | undefined
  month: string
  editing: string | null
  onEdit: (id: string | null) => void
  run: Run
  /** Like `run`, but a failure reaches the caller, so the box that asked can show it. */
  write: (fn: () => Promise<unknown>) => Promise<void>
}) {
  const { month, run, ready, stale } = props
  const wide = props.span > 4
  const refresh = useRefresh()
  return props.goals.map((goal) => {
    const b = ready ? props.balances.find((x) => x.goalId === goal.id) : undefined
    if (props.editing === goal.id) {
      return (
        <tr key={goal.id} className="add-row">
          <td colSpan={props.span}>
            <GoalForm
              label={`Edit goal ${goal.name}`}
              goal={goal}
              accounts={props.accounts}
              onSubmit={async (input) => {
                await budget.updateGoal(goal.id, input)
                refresh()
              }}
              onDone={() => props.onEdit(null)}
            />
          </td>
        </tr>
      )
    }
    return (
      <tr key={goal.id} className={goal.archived ? 'goal-row hidden-row' : 'goal-row'}>
        <th scope="row">
          <span className="name-cell">
            <span className="goal-name">
              <span>
                {goal.name}
                {goal.archived && <span className="tag">Archived</span>}
              </span>
              <span className="goal-status muted">
                {goalStatus(
                  goal,
                  b,
                  props.accounts.find((a) => a.id === goal.heldInAccountId)?.name,
                ).join(' · ')}
              </span>
              <span
                className="goal-bar"
                role="progressbar"
                aria-label={`${goal.name} funded`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={b?.percentFunded ?? 0}
              >
                <span style={{ width: `${b?.percentFunded ?? 0}%` }} />
              </span>
            </span>
            <span className="row-actions">
              <Menu
                label={`Options for goal ${goal.name}`}
                items={
                  goal.archived
                    ? [
                        {
                          label: 'Unarchive',
                          onSelect: () => void run(() => budget.unarchiveGoal(goal.id)),
                        },
                        { label: 'Delete', onSelect: () => void remove(goal, run) },
                      ]
                    : [
                        { label: 'Edit', onSelect: () => props.onEdit(goal.id) },
                        {
                          label: 'Archive',
                          onSelect: () => {
                            const held = b?.available ?? 0
                            const warning =
                              held === 0 ? '' : ` Its ${money(held)} goes back to the category.`
                            if (confirm(`Archive ${goal.name}?${warning}`))
                              void run(() => budget.archiveGoal(goal.id, { month }))
                          },
                        },
                        { label: 'Delete', onSelect: () => void remove(goal, run) },
                      ]
                }
              />
            </span>
          </span>
        </th>
        {wide && <PeekCells side="prev" figures={goalFigures(props.prev, goal.id)} />}
        <td className="num">
          {ready ? (
            <AssignedInput
              label={`Assigned for goal ${goal.name}`}
              value={b?.assigned ?? 0}
              disabled={goal.archived || stale}
              onCommit={(delta) =>
                props.write(() =>
                  budget.allocate({
                    month,
                    categoryId: goal.categoryId,
                    goalId: goal.id,
                    amount: delta,
                    note: 'Set in budget',
                  }),
                )
              }
            />
          ) : (
            <Skeleton />
          )}
        </td>
        <td className="num col-activity">{ready ? money(b?.activity ?? 0) : <Skeleton />}</td>
        <td className="num">
          {ready ? (
            <span className={`pill ${tone(b?.available ?? 0)}`}>{money(b?.available ?? 0)}</span>
          ) : (
            <Skeleton />
          )}
        </td>
        {wide && <PeekCells side="next" figures={goalFigures(props.next, goal.id)} />}
      </tr>
    )
  })
}

function remove(goal: Goal, run: Run) {
  if (confirm(`Delete goal ${goal.name}?`)) return run(() => budget.deleteGoal(goal.id))
}
