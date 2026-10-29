import { LineChart } from '@budget-fi/ui'
import { useState } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery } from './data.ts'
import { money, moneyShort, monthOf, todayIso } from './format.ts'
import { monthYear } from './retirement-text.ts'

const WINDOWS = [
  { months: 12, label: 'Last 12 months' },
  { months: 24, label: 'Last 2 years' },
  { months: 60, label: 'Last 5 years' },
] as const

const TYPE_LABELS = {
  checking: 'Checking',
  savings: 'Savings',
  credit: 'Credit card',
  investment: 'Investment',
} as const

/** Net worth at each month's end across every account, with the accounts behind today's figure. */
export function NetWorthCard({ today }: { today: Date }) {
  const month = monthOf(todayIso(today))
  const [months, setMonths] = useState<number>(WINDOWS[0].months)
  const report = useBudgetQuery(() => budget.getNetWorthReport({ month, months }), [month, months])
  const data = report.data
  const first = data?.months[0]
  const last = data?.months[data.months.length - 1]
  const change = first && last ? last.netWorth - first.netWorth : 0

  return (
    <section className="card" aria-label="Net worth">
      <header className="card-header">
        <h2>Net worth</h2>
        <select
          aria-label="Net worth period"
          value={months}
          onChange={(e) => setMonths(Number(e.target.value))}
        >
          {WINDOWS.map((w) => (
            <option key={w.months} value={w.months}>
              {w.label}
            </option>
          ))}
        </select>
      </header>
      {report.error && (
        <p className="error" role="alert">
          {report.error.message}
        </p>
      )}
      {data && last && first && (
        <>
          <p className="hero-figure">
            <strong className={last.netWorth < 0 ? 'negative' : undefined}>
              {money(last.netWorth)}
            </strong>
            <small className="muted">
              {' '}
              {change === 0
                ? `no change since ${monthYear(first.month)}`
                : `${change > 0 ? '+' : '-'}${money(Math.abs(change))} since ${monthYear(first.month)}`}
            </small>
          </p>
          <LineChart
            ariaLabel={`Net worth by month, ${monthYear(first.month)} to ${monthYear(last.month)}`}
            labels={data.months.map((m) => monthYear(m.month))}
            series={[
              {
                label: 'Net worth',
                values: data.months.map((m) => m.netWorth),
                color: 'var(--series-1)',
              },
            ]}
            formatValue={money}
            formatTick={moneyShort}
          />
          <details>
            <summary>Show as a table</summary>
            <div className="table-wrap">
              <table className="report-table">
                <thead>
                  <tr>
                    <th scope="col">Month end</th>
                    <th scope="col" className="num">
                      Assets
                    </th>
                    <th scope="col" className="num">
                      Debts
                    </th>
                    <th scope="col" className="num">
                      Net worth
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.months].reverse().map((m) => (
                    <tr key={m.month}>
                      <th scope="row">{monthYear(m.month)}</th>
                      <td className="num">{money(m.assets)}</td>
                      <td className="num">{money(m.liabilities)}</td>
                      <td className="num">{money(m.netWorth)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          {data.accounts.length > 0 && (
            <dl className="fund-figures">
              {data.accounts.map((a) => (
                <div key={a.accountId} style={{ display: 'contents' }}>
                  <dt>
                    {a.name}
                    {a.closed && <span className="muted"> (closed)</span>}
                    <small className="muted"> · {TYPE_LABELS[a.type]}</small>
                  </dt>
                  <dd className={a.value < 0 ? 'negative' : undefined}>{money(a.value)}</dd>
                </div>
              ))}
            </dl>
          )}
          {data.accounts.length === 0 && <p className="muted">No account has a balance yet.</p>}
        </>
      )}
      <p className="muted">
        Every account counts, on budget or not. A bank or card account is worth what its
        transactions add up to; an investment account is worth its newest recorded value, and until
        it has one, what has been moved into it.
      </p>
    </section>
  )
}
