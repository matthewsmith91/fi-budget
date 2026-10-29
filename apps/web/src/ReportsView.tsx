import { useState } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery } from './data.ts'
import { EmergencyFundCard } from './EmergencyFundCard.tsx'
import { money, monthLabel, monthOf, shiftMonth, todayIso } from './format.ts'

/** Whole percent of `part` in `whole`, or null when there is nothing to divide. */
const share = (part: number, whole: number) => (whole > 0 ? Math.round((part * 100) / whole) : null)

const monthName = (month: string) => {
  const { name, year } = monthLabel(month)
  return `${name.slice(0, 3)} ${year}`
}

export function ReportsView({ today }: { today: Date }) {
  // The last complete month, so a half-spent current month doesn't pull the averages down.
  const [month, setMonth] = useState(() => shiftMonth(monthOf(todayIso(today)), -1))
  const report = useBudgetQuery(() => budget.getNeedsWantsReport({ month }), [month])
  const label = monthLabel(month)
  const data = report.data

  return (
    <div className="page">
      <header className="page-header">
        <h1>Needs vs wants</h1>
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
            through {label.name} <span className="muted">{label.year}</span>
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
      </header>

      {report.error && (
        <p className="error" role="alert">
          {report.error.message}
        </p>
      )}

      <section className="card" aria-label="Average month">
        <h2>Average month</h2>
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

      <section className="card" aria-label="By month">
        <h2>By month</h2>
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
