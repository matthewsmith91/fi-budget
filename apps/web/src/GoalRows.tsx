import { cents, formatCents, parseCents, type Goal, type GoalBalance } from '@budget-fi/core'
import { useState, type FormEvent } from 'react'
import { AssignedInput } from './AssignedInput.tsx'
import { budget } from './client.ts'
import { goalStatus } from './goal-text.ts'
import { money } from './format.ts'
import { Menu } from './Menu.tsx'

type Run = (fn: () => Promise<unknown>) => Promise<void>

const tone = (available: number) => (available < 0 ? 'bad' : available === 0 ? 'zero' : 'good')

/** Name, target and optional date: used to add a goal and to edit one. */
export function GoalForm(props: {
  label: string
  goal?: Goal
  onSubmit: (input: {
    name: string
    targetAmount: number
    targetDate: string | null
  }) => Promise<void>
  onDone: () => void
}) {
  const { goal } = props
  const [name, setName] = useState(goal?.name ?? '')
  const [target, setTarget] = useState(
    goal ? formatCents(cents(goal.targetAmount), { symbol: false }) : '',
  )
  const [date, setDate] = useState(goal?.targetDate ?? '')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const targetAmount = parseCents(target)
    if (targetAmount === null || targetAmount <= 0) {
      return setError('Enter the target as dollars, like 1200.00')
    }
    setError(null)
    await props.onSubmit({ name, targetAmount, targetDate: date || null })
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
  balances: GoalBalance[]
  month: string
  editing: string | null
  onEdit: (id: string | null) => void
  run: Run
  onInvalid: () => void
}) {
  const { month, run } = props
  return props.goals.map((goal) => {
    const b = props.balances.find((x) => x.goalId === goal.id)
    if (props.editing === goal.id) {
      return (
        <tr key={goal.id} className="add-row">
          <td colSpan={4}>
            <GoalForm
              label={`Edit goal ${goal.name}`}
              goal={goal}
              onSubmit={(input) => run(() => budget.updateGoal(goal.id, input))}
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
              <span className="goal-status muted">{goalStatus(goal, b).join(' · ')}</span>
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
        <td className="num">
          <AssignedInput
            label={`Assigned for goal ${goal.name}`}
            value={b?.assigned ?? 0}
            disabled={goal.archived}
            onCommit={(delta) =>
              void run(() =>
                budget.allocate({
                  month,
                  categoryId: goal.categoryId,
                  goalId: goal.id,
                  amount: delta,
                  note: 'Set in budget',
                }),
              )
            }
            onInvalid={props.onInvalid}
          />
        </td>
        <td className="num col-activity">{money(b?.activity ?? 0)}</td>
        <td className="num">
          <span className={`pill ${tone(b?.available ?? 0)}`}>{money(b?.available ?? 0)}</span>
        </td>
      </tr>
    )
  })
}

function remove(goal: Goal, run: Run) {
  if (confirm(`Delete goal ${goal.name}?`)) return run(() => budget.deleteGoal(goal.id))
}
