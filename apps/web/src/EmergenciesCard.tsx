import { useState } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery } from './data.ts'
import { money, monthOf, shortDate, todayIso } from './format.ts'
import { refillText } from './fund-text.ts'

/**
 * The year's emergencies: transactions marked as paid for from the emergency fund, what each took
 * out of it and how long it took to get back to where it would have been. Hidden while there is
 * no fund and nothing to show.
 */
export function EmergenciesCard({ today }: { today: Date }) {
  const asOf = monthOf(todayIso(today))
  const thisYear = Number(asOf.slice(0, 4))
  const [year, setYear] = useState(thisYear)
  const report = useBudgetQuery(() => budget.getEmergencyReport({ year, asOf }), [year, asOf])
  const groups = useBudgetQuery(() => budget.listCategoryGroups())
  const data = report.data
  const names = new Map(
    (groups.data ?? []).flatMap((g) => g.categories.map((c) => [c.id, c.name] as const)),
  )

  // Another year's emergencies are worth a look even after the fund is gone.
  if (data && !data.hasFund && data.draws.length === 0 && year === thisYear) return null

  return (
    <section className="card" aria-label="Emergencies">
      <div className="card-header">
        <h2>Emergencies</h2>
        <div className="month-nav">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous year"
            onClick={() => setYear(year - 1)}
          >
            ‹
          </button>
          <span>{year}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Next year"
            disabled={year >= thisYear}
            onClick={() => setYear(year + 1)}
          >
            ›
          </button>
        </div>
      </div>

      {data && data.draws.length === 0 && (
        <p className="muted">
          No emergencies in {year}. Tick Emergency when you edit a transaction and its amount moves
          from the emergency fund into the transaction’s category.
        </p>
      )}
      {data && data.draws.length > 0 && (
        <>
          <p>
            <strong>{money(data.total)}</strong> came out of the fund for{' '}
            {data.draws.length === 1 ? 'one emergency' : `${data.draws.length} emergencies`} in{' '}
            {year}.
          </p>
          <div className="table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Payee</th>
                  <th scope="col">Category</th>
                  <th scope="col" className="num">
                    Spent
                  </th>
                  <th scope="col" className="num">
                    From the fund
                  </th>
                  <th scope="col" className="num">
                    Fund after
                  </th>
                  <th scope="col">Refilled in</th>
                </tr>
              </thead>
              <tbody>
                {data.draws.map((d) => (
                  <tr key={d.transactionId}>
                    <td>{shortDate(d.date)}</td>
                    <td>{d.payee ?? ''}</td>
                    <td>{d.categoryIds.map((id) => names.get(id) ?? 'Removed').join(', ')}</td>
                    <td className="num">{money(-d.amount)}</td>
                    <td className="num">{money(d.drawn)}</td>
                    <td className="num">{d.balanceAfter === null ? '—' : money(d.balanceAfter)}</td>
                    <td>{refillText(d)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {report.error && (
        <p className="error" role="alert">
          {report.error.message}
        </p>
      )}
    </section>
  )
}
