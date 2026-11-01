import { useState } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery } from './data.ts'
import { EducationCard } from './EducationCard.tsx'
import { EmergenciesCard } from './EmergenciesCard.tsx'
import { EmergencyFundCard } from './EmergencyFundCard.tsx'
import { money, monthLabel, monthOf, shiftMonth, todayIso } from './format.ts'
import { NetWorthCard } from './NetWorthCard.tsx'
import { RetirementCard } from './RetirementCard.tsx'
import { RetirementSpendCard } from './RetirementSpendCard.tsx'
import { RothContributionsCard } from './RothContributionsCard.tsx'

/** Whole percent of `part` in `whole`, or null when there is nothing to divide. */
const share = (part: number, whole: number) => (whole > 0 ? Math.round((part * 100) / whole) : null)

const monthName = (month: string) => {
  const { name, year } = monthLabel(month)
  return `${name.slice(0, 3)} ${year}`
}

export function ReportsView({ today }: { today: Date }) {
  // The last complete month, so a half-spent current month doesn't pull the averages down.
  const [month, setMonth] = useState(() => shiftMonth(monthOf(todayIso(today)), -1))
  // Narrows the Average month and By month cards; the other cards aren't about categories.
  const [categoryId, setCategoryId] = useState('')
  const groups = useBudgetQuery(() => budget.listCategoryGroups())
  const report = useBudgetQuery(
    () => budget.getNeedsWantsReport({ month, ...(categoryId ? { categoryId } : {}) }),
    [month, categoryId],
  )
  const categoryName = (groups.data ?? [])
    .flatMap((g) => g.categories)
    .find((c) => c.id === categoryId)?.name
  const scope = categoryId ? ` · ${categoryName ?? 'Unknown category'}` : ''
  const label = monthLabel(month)
  const data = report.data

  return (
    <div className="page">
      <header className="page-header">
        <h1>Reports</h1>
        <div className="month-nav">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous month"
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            ‹
          </button>
          <span className="report-month">
            Needs and wants through {label.name} <span className="muted">{label.year}</span>
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="Next month"
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            ›
          </button>
        </div>
        <label className="report-filter">
          <span>Category</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All categories</option>
            {categoryId && categoryName === undefined && (
              <option value={categoryId}>Unknown category</option>
            )}
            {(groups.data ?? []).map((g) => {
              const categories = g.categories.filter(
                (c) => !c.creditCardAccountId && (!c.hidden || c.id === categoryId),
              )
              return categories.length === 0 ? null : (
                <optgroup key={g.id} label={g.name}>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              )
            })}
          </select>
          <span className="muted">Applies to Average month and By month</span>
        </label>
      </header>

      {report.error && (
        <p className="error" role="alert">
          {report.error.message}
        </p>
      )}

      <NetWorthCard today={today} />

      <RetirementCard today={today} />

      <RetirementSpendCard month={month} today={today} />

      <EducationCard today={today} />

      <section className="card" aria-label="Average month">
        <h2>Average month{scope}</h2>
        <div className="table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th scope="col">Trailing</th>
                <th scope="col" className="num">
                  Needs
                </th>
                <th scope="col" className="num">
                  Wants
                </th>
                <th scope="col" className="num">
                  Total
                </th>
                <th scope="col" className="num">
                  Needs share
                </th>
              </tr>
            </thead>
            <tbody>
              {(data?.averages ?? []).map((a) => {
                const total = a.need + a.want
                const pct = share(a.need, total)
                return (
                  <tr key={a.window}>
                    <th scope="row">
                      {a.window} months
                      {a.months < a.window && (
                        <span className="muted"> (only {a.months} of history)</span>
                      )}
                    </th>
                    <td className="num">{money(a.need)}</td>
                    <td className="num">{money(a.want)}</td>
                    <td className="num">{money(total)}</td>
                    <td className="num">{pct === null ? '' : `${pct}%`}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="muted">
          The average Need spending is your bare-bones month, the number an emergency fund is sized
          against.
        </p>
      </section>

      <EmergencyFundCard month={month} today={today} />

      <EmergenciesCard today={today} />

      <RothContributionsCard today={today} />

      <section className="card" aria-label="By month">
        <h2>By month{scope}</h2>
        <div className="table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col" className="num">
                  Needs
                </th>
                <th scope="col" className="num">
                  Wants
                </th>
                <th scope="col" className="num">
                  Total
                </th>
                <th scope="col" className="num">
                  Needs share
                </th>
              </tr>
            </thead>
            <tbody>
              {[...(data?.months ?? [])].reverse().map((m) => {
                const total = m.need + m.want
                const pct = share(m.need, total)
                return (
                  <tr key={m.month}>
                    <th scope="row">{monthName(m.month)}</th>
                    <td className="num">{money(m.need)}</td>
                    <td className="num">{money(m.want)}</td>
                    <td className="num">{money(total)}</td>
                    <td className="num">{pct === null ? '' : `${pct}%`}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="muted">
          Counts categorized spending from budget accounts, including goal spending and money sent
          to a tracking account under a category. A category’s tag decides need or want unless a
          split overrides it. Uncategorized spending isn’t counted.
        </p>
      </section>
    </div>
  )
}
