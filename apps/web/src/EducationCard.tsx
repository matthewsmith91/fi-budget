import { type EducationProjection } from '@budget-fi/core'
import { LineChart } from '@budget-fi/ui'
import { useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { money, moneyShort, monthOf, todayIso } from './format.ts'
import {
  educationFormOf,
  emptyEducationForm,
  parseEducationForm,
  type EducationForm,
} from './planning-text.ts'
import { monthYear, timeUntil } from './retirement-text.ts'

/**
 * Saving for each child's education: what a plan is projected to hold in the month the money is
 * needed against what that costs, in today's prices.
 */
export function EducationCard({ today }: { today: Date }) {
  const asOf = monthOf(todayIso(today))
  const refresh = useRefresh()
  const projections = useBudgetQuery(() => budget.getEducationProjections({ asOf }), [asOf])
  const accounts = useBudgetQuery(() => budget.listAccounts())
  const goals = useBudgetQuery(() => budget.listGoals())
  const groups = useBudgetQuery(() => budget.listCategoryGroups())

  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<EducationForm>(emptyEducationForm)
  const [error, setError] = useState<string | null>(null)

  const investment = (accounts.data ?? []).filter((a) => a.type === 'investment' && !a.closed)
  const categoryName = new Map(
    (groups.data ?? []).flatMap((g) => g.categories).map((c) => [c.id, c.name]),
  )
  const goalChoices = (goals.data ?? []).filter((g) => !g.archived)
  const accountName = (id: string | null) =>
    id === null ? null : ((accounts.data ?? []).find((a) => a.id === id)?.name ?? null)
  const goalName = (id: string | null) => {
    const goal = (goals.data ?? []).find((g) => g.id === id)
    return goal ? goal.name : null
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const parsed = parseEducationForm(form)
    if (!parsed.ok) return setError(parsed.error)
    try {
      if (editing) await budget.updateEducationPlan(editing, parsed.input)
      else await budget.createEducationPlan(parsed.input)
      reset()
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  async function remove(id: string) {
    setError(null)
    try {
      await budget.deleteEducationPlan(id)
      if (editing === id) reset()
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  function reset() {
    setEditing(null)
    setForm(emptyEducationForm)
  }

  const set = (patch: Partial<EducationForm>) => setForm({ ...form, ...patch })

  return (
    <section className="card" aria-label="Education savings">
      <h2>Education savings</h2>

      {projections.data && projections.data.length === 0 && (
        <p className="muted">
          Add a plan for each child: what their education costs in today’s prices, when the money is
          needed, and the 529 or other account it is saved in.
        </p>
      )}
      {(projections.data ?? []).map((p) => (
        <Plan
          key={p.plan.id}
          projection={p}
          where={[accountName(p.plan.accountId), goalName(p.plan.goalId)]
            .filter(Boolean)
            .join(' · ')}
          onEdit={() => {
            setEditing(p.plan.id)
            setForm(educationFormOf(p.plan))
            setError(null)
          }}
          onDelete={() => void remove(p.plan.id)}
        />
      ))}

      <form
        className="inline wrap"
        noValidate
        aria-label={editing ? 'Edit education plan' : 'Add an education plan'}
        onSubmit={(e) => void save(e)}
      >
        <label>
          Child
          <input
            aria-label="Plan name"
            placeholder="Emma"
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </label>
        <label>
          Account
          <select
            aria-label="Plan account"
            value={form.accountId}
            onChange={(e) => set({ accountId: e.target.value, goalId: '' })}
          >
            <option value="">None yet</option>
            {investment.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {form.accountId && (
          <label>
            Their share
            <select
              aria-label="Plan goal"
              value={form.goalId}
              onChange={(e) => set({ goalId: e.target.value })}
            >
              <option value="">Whole account</option>
              {goalChoices.map((g) => (
                <option key={g.id} value={g.id}>
                  {categoryName.get(g.categoryId) ?? ''}: {g.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Cost in today’s prices
          <input
            inputMode="decimal"
            aria-label="Education cost"
            placeholder="80,000.00"
            value={form.targetAmount}
            onChange={(e) => set({ targetAmount: e.target.value })}
          />
        </label>
        <label>
          Needed by
          <input
            type="month"
            aria-label="Plan month"
            value={form.targetMonth}
            onChange={(e) => set({ targetMonth: e.target.value })}
          />
        </label>
        <label>
          Contribution a month
          <input
            inputMode="decimal"
            aria-label="Plan contribution"
            placeholder="0.00"
            value={form.monthlyContribution}
            onChange={(e) => set({ monthlyContribution: e.target.value })}
          />
        </label>
        <label>
          Return a year (%)
          <input
            type="number"
            aria-label="Plan return"
            step="any"
            value={form.returnRate}
            onChange={(e) => set({ returnRate: e.target.value })}
          />
        </label>
        <label>
          Costs rise a year (%)
          <input
            type="number"
            aria-label="Yearly cost increase"
            step="any"
            value={form.inflationRate}
            onChange={(e) => set({ inflationRate: e.target.value })}
          />
        </label>
        <button type="submit">{editing ? 'Save plan' : 'Add plan'}</button>
        {editing && (
          <button type="button" onClick={reset}>
            Cancel
          </button>
        )}
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {projections.error && (
        <p className="error" role="alert">
          {projections.error.message}
        </p>
      )}
      <p className="muted">
        Figures are in today’s prices: the account grows at the return after the rise in what
        college costs, and each month’s contribution stays the same in those terms. A plan that
        names a goal counts only that goal’s share of the account. A steady-return estimate, not a
        forecast.
      </p>
    </section>
  )
}

function Plan({
  projection: p,
  where,
  onEdit,
  onDelete,
}: {
  projection: EducationProjection
  where: string
  onEdit: () => void
  onDelete: () => void
}) {
  const { plan } = p
  const shown = Math.min(p.percentFunded, 100)
  return (
    <div className="stack stretch">
      <div className="row spread">
        <strong>{plan.name}</strong>
        <span className={p.onTrack ? undefined : 'negative'}>
          {money(p.projected)} of {money(plan.targetAmount)}
        </span>
      </div>
      <progress max={100} value={shown} aria-label={`${plan.name}’s education savings`} />
      <small className="muted">
        {p.monthsToTarget === 0
          ? `The money is needed now (${monthYear(plan.targetMonth)}), so this is what is saved: `
          : `By ${monthYear(plan.targetMonth)}, in ${timeUntil(p.monthsToTarget)}: `}
        {p.onTrack ? (
          <>on track, {money(p.gap)} to spare.</>
        ) : (
          <>
            short by {money(-p.gap)} ({p.percentFunded}% funded)
            {p.monthsToTarget > 0 && <>; {money(p.monthlyNeeded)} a month would close it</>}.
          </>
        )}
        {where && (
          <>
            {' '}
            Saved in {where}, {money(p.startingBalance)} today.
          </>
        )}
        {!where && <> Nothing counted as saved yet.</>}
      </small>
      {p.points.length > 1 && (
        <details>
          <summary>Show the projection</summary>
          <LineChart
            ariaLabel={`Projected education savings for ${plan.name} until ${monthYear(plan.targetMonth)}`}
            labels={p.points.map((x) => x.month.slice(0, 4))}
            detailLabels={p.points.map((x) => monthYear(x.month))}
            series={[
              {
                label: 'Projected savings',
                values: p.points.map((x) => x.balance),
                color: 'var(--series-1)',
              },
              {
                label: 'Cost',
                values: p.points.map(() => plan.targetAmount),
                color: 'var(--series-2)',
              },
            ]}
            formatValue={money}
            formatTick={moneyShort}
          />
        </details>
      )}
      <div className="row">
        <button type="button" onClick={onEdit} aria-label={`Edit ${plan.name}’s plan`}>
          Edit
        </button>
        <button type="button" onClick={onDelete} aria-label={`Delete ${plan.name}’s plan`}>
          Delete
        </button>
      </div>
    </div>
  )
}
