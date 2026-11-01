import {
  LOOKBACK_RANGE,
  WITHDRAWAL_RATE_RANGE,
  type RetirementFixedItemFigures,
  type RetirementSpendCategory,
} from '@budget-fi/core'
import { useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { money, monthLabel, monthOf, todayIso } from './format.ts'
import {
  ageWindow,
  emptyFixedItemForm,
  fixedItemFormOf,
  parseFixedItemForm,
  type FixedItemForm,
} from './planning-text.ts'
import { RETIREMENT_STATUS_LABELS, retirementTag } from './retirement-text.ts'

/** How many categories the table shows before the rest are folded away. */
const TOP = 8

/**
 * What retirement costs a year and whether the projected portfolio covers it. The baseline is the
 * real spending of the budget's categories, adjusted by what each does in retirement.
 */
export function RetirementSpendCard({ month, today }: { month: string; today: Date }) {
  const asOf = monthOf(todayIso(today))
  const refresh = useRefresh()
  const spending = useBudgetQuery(
    () => budget.getRetirementSpending({ month, asOf }),
    [month, asOf],
  )
  const data = spending.data
  const saved = data?.settings

  // null until typed in: the field shows what is saved
  const [rateEdit, setRateEdit] = useState<string | null>(null)
  const [lookbackEdit, setLookbackEdit] = useState<string | null>(null)
  const rate = rateEdit ?? (saved ? String(saved.withdrawalRate) : '')
  const lookback = lookbackEdit ?? (saved ? String(saved.lookbackMonths) : '')
  const [settingsError, setSettingsError] = useState<string | null>(null)

  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<FixedItemForm>(emptyFixedItemForm)
  const [itemError, setItemError] = useState<string | null>(null)

  async function saveSettings(e: FormEvent) {
    e.preventDefault()
    setSettingsError(null)
    const withdrawalRate = rate.trim() === '' ? NaN : Number(rate)
    const lookbackMonths = lookback.trim() === '' ? NaN : Number(lookback)
    try {
      await budget.setRetirementSettings({
        ...(await budget.getRetirementSettings()),
        withdrawalRate,
        lookbackMonths,
      })
      setRateEdit(null)
      setLookbackEdit(null)
      refresh()
    } catch (err) {
      setSettingsError(messageOf(err))
    }
  }

  async function saveItem(e: FormEvent) {
    e.preventDefault()
    setItemError(null)
    const parsed = parseFixedItemForm(form)
    if (!parsed.ok) return setItemError(parsed.error)
    try {
      if (editing) await budget.updateRetirementFixedItem(editing, parsed.input)
      else await budget.createRetirementFixedItem(parsed.input)
      setEditing(null)
      setForm(emptyFixedItemForm)
      refresh()
    } catch (err) {
      setItemError(messageOf(err))
    }
  }

  async function removeItem(item: RetirementFixedItemFigures) {
    setItemError(null)
    try {
      await budget.deleteRetirementFixedItem(item.id)
      if (editing === item.id) {
        setEditing(null)
        setForm(emptyFixedItemForm)
      }
      refresh()
    } catch (err) {
      setItemError(messageOf(err))
    }
  }

  const through = monthLabel(month)
  const categories = data?.categories ?? []
  const funded = data?.fundedPercent == null ? null : Math.min(data.fundedPercent, 100)

  return (
    <section className="card" aria-label="Retirement spending">
      <h2>Retirement spending</h2>

      {data && data.requiredPortfolio !== null && (
        <>
          <p className="hero-figure">
            <strong>{money(data.requiredPortfolio)}</strong>
            <small className="muted">
              {' '}
              needed to cover {money(data.portfolioAnnual)} a year at a{' '}
              {data.settings.withdrawalRate}% withdrawal rate
            </small>
          </p>
          {data.succeeds !== null && data.projected !== null && data.surplus !== null && (
            <>
              <p className={data.succeeds ? undefined : 'warn'} role="status">
                {data.succeeds ? (
                  <>
                    <strong>On track.</strong> At {data.targetAge}
                    {ageOwner(data.referenceName)} the accounts are projected to hold{' '}
                    {money(data.projected)}, {money(data.surplus)} more than needed.
                  </>
                ) : (
                  <>
                    <strong>Short by {money(-data.surplus)}.</strong> At {data.targetAge}
                    {ageOwner(data.referenceName)} the accounts are projected to hold{' '}
                    {money(data.projected)}, {data.fundedPercent}% of what is needed.
                  </>
                )}
              </p>
              {funded !== null && (
                <progress max={100} value={funded} aria-label="Share of the needed portfolio" />
              )}
            </>
          )}
          {data.succeeds === null && data.projectionProblem !== null && (
            <p className="muted">{data.projectionProblem}</p>
          )}
          <p className="muted">
            Every $100 a month of spending in retirement adds {money(data.perHundredMonthly)} to the
            portfolio needed.
          </p>
        </>
      )}
      {data && data.requiredPortfolio === null && (
        <p className="muted">
          No categorized spending through {through.name} {through.year} yet, so there is nothing to
          base retirement spending on.
        </p>
      )}

      {data && data.requiredPortfolio !== null && (
        <dl className="fund-figures">
          <dt>Spending that continues or changes</dt>
          <dd>
            {money(data.baselineMonthly)} a month
            <span className="muted"> ({money(data.baselineMonthly * 12)} a year)</span>
          </dd>
          <dt>Spending that ends</dt>
          <dd>{money(data.endingMonthly)} a month today</dd>
          <dt>Added costs at {data.targetAge}</dt>
          <dd>{money(data.fixedAnnual)} a year</dd>
          <dt>Spend a year</dt>
          <dd>
            <strong>{money(data.annualSpend)}</strong>
            {data.incomeReplacement !== null && (
              <span className="muted">
                {' '}
                ({data.incomeReplacement}% of today’s household income)
              </span>
            )}
          </dd>
          {data.benefits.length > 0 && (
            <>
              <dt>Social Security and pensions at {data.targetAge}</dt>
              <dd>−{money(data.benefitsAnnual)} a year</dd>
              <dt>The portfolio covers</dt>
              <dd>
                <strong>{money(data.portfolioAnnual)}</strong> a year
              </dd>
            </>
          )}
        </dl>
      )}
      {data && data.benefits.length > 0 && (
        <ul className="plain stack stretch" aria-label="Benefits">
          {data.benefits.map((b) => (
            <li key={`${b.memberId}-${b.kind}`}>
              {b.name}’s {b.kind === 'pension' ? 'pension' : 'Social Security'}{' '}
              <span className="muted">
                {money(b.monthly * 12)} a year from age {b.claimAge}
                {b.active ? '' : `, not yet paying at ${data.targetAge}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {data && data.schedule.length > 1 && (
        <p className="muted">
          What the portfolio covers changes as added costs and benefits start and stop:{' '}
          {data.schedule
            .map(
              (s) =>
                `${money(s.annual)} a year ${s.toAge === null ? `from ${s.fromAge}` : `from ${s.fromAge} to ${s.toAge}`}`,
            )
            .join(', then ')}
          . The check above uses the first figure, which is the careful one.
        </p>
      )}

      {categories.length > 0 && (
        <>
          <h3>What drives it</h3>
          <CategoryTable rows={categories.slice(0, TOP)} />
          {categories.length > TOP && (
            <details>
              <summary>Show the other {categories.length - TOP} categories</summary>
              <CategoryTable rows={categories.slice(TOP)} />
            </details>
          )}
          <p className="muted">
            Averaged over {data!.averagedMonths} month{data!.averagedMonths === 1 ? '' : 's'}{' '}
            through {through.name} {through.year}
            {data!.averagedMonths < data!.settings.lookbackMonths
              ? `, all the history there is of the last ${data!.settings.lookbackMonths}`
              : ''}
            . Set what each category does in retirement from its menu in the budget (“In
            retirement…”): a contribution to a 529 or retirement account, or a mortgage that will be
            paid off, should end.
          </p>
        </>
      )}

      <h3>Costs that don’t exist today</h3>
      {data?.referenceName && (
        <p className="muted">Ages are {data.referenceName}’s, who retires last.</p>
      )}
      {data && data.fixedItems.length === 0 && (
        <p className="muted">
          Health insurance before Medicare, extra home maintenance: anything retirement adds.
        </p>
      )}
      {data && data.fixedItems.length > 0 && (
        <ul className="plain stack stretch">
          {data.fixedItems.map((item) => (
            <li key={item.id} className="row spread">
              <span>
                {item.name}{' '}
                <span className="muted">
                  {money(item.annualAmount)} a year, {ageWindow(item.startAge, item.endAge)}
                  {item.active ? '' : `, not at ${data.targetAge}`}
                </span>
              </span>
              <span className="row">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(item.id)
                    setForm(fixedItemFormOf(item))
                    setItemError(null)
                  }}
                  aria-label={`Edit ${item.name}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void removeItem(item)}
                  aria-label={`Delete ${item.name}`}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="inline wrap"
        noValidate
        aria-label={editing ? 'Edit added cost' : 'Add a cost'}
        onSubmit={(e) => void saveItem(e)}
      >
        <label>
          Cost
          <input
            aria-label="Cost name"
            placeholder="Health insurance"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label>
          Per year
          <input
            inputMode="decimal"
            aria-label="Cost per year"
            placeholder="0.00"
            value={form.annualAmount}
            onChange={(e) => setForm({ ...form, annualAmount: e.target.value })}
          />
        </label>
        <label>
          From age
          <input
            type="number"
            min={0}
            max={120}
            aria-label="Cost start age"
            placeholder="retirement"
            value={form.startAge}
            onChange={(e) => setForm({ ...form, startAge: e.target.value })}
          />
        </label>
        <label>
          Until age
          <input
            type="number"
            min={0}
            max={120}
            aria-label="Cost end age"
            placeholder="always"
            value={form.endAge}
            onChange={(e) => setForm({ ...form, endAge: e.target.value })}
          />
        </label>
        <button type="submit">{editing ? 'Save cost' : 'Add cost'}</button>
        {editing && (
          <button
            type="button"
            onClick={() => {
              setEditing(null)
              setForm(emptyFixedItemForm)
              setItemError(null)
            }}
          >
            Cancel
          </button>
        )}
      </form>
      {itemError && (
        <p className="error" role="alert">
          {itemError}
        </p>
      )}

      <form
        className="inline wrap"
        noValidate
        aria-label="Retirement spending assumptions"
        onSubmit={(e) => void saveSettings(e)}
      >
        <label>
          Withdrawal rate (%)
          <input
            type="number"
            aria-label="Withdrawal rate"
            min={WITHDRAWAL_RATE_RANGE.min}
            max={WITHDRAWAL_RATE_RANGE.max}
            step="any"
            value={rate}
            onChange={(e) => setRateEdit(e.target.value)}
          />
        </label>
        <label>
          Average spending over (months)
          <input
            type="number"
            aria-label="Spending lookback"
            min={LOOKBACK_RANGE.min}
            max={LOOKBACK_RANGE.max}
            step={1}
            value={lookback}
            onChange={(e) => setLookbackEdit(e.target.value)}
          />
        </label>
        <button type="submit">Save</button>
      </form>
      {settingsError && (
        <p className="error" role="alert">
          {settingsError}
        </p>
      )}
      {spending.error && (
        <p className="error" role="alert">
          {spending.error.message}
        </p>
      )}
      <p className="muted">
        The portfolio needed is a year’s spending divided by the withdrawal rate (4% is the usual
        starting point). Everything is in today’s dollars, and uncategorized spending isn’t counted.
        It is a rule of thumb, not a guarantee.
      </p>
    </section>
  )
}

/** ` (Jessica’s age)`, so the age isn't taken for the reader's own. */
const ageOwner = (name: string | null) => (name ? ` (${name}’s age)` : '')

function CategoryTable({ rows }: { rows: RetirementSpendCategory[] }) {
  return (
    <div className="table-wrap">
      <table className="report-table">
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col" className="num">
              Today a month
            </th>
            <th scope="col" className="num">
              In retirement
            </th>
            <th scope="col" className="num">
              Portfolio it needs
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const tag = retirementTag(c.status, c.multiplier)
            return (
              <tr key={c.categoryId}>
                <th scope="row">
                  {c.name}
                  {tag && (
                    <span
                      className="tag retirement"
                      title={`In retirement: ${RETIREMENT_STATUS_LABELS[c.status]}`}
                    >
                      {tag}
                    </span>
                  )}
                </th>
                <td className="num">{money(c.monthly)}</td>
                <td className="num">{money(c.retirementMonthly)}</td>
                <td className="num">{money(c.required)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
