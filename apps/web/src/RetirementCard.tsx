import { INFLATION_RATE_RANGE, RETURN_RATE_RANGE } from '@budget-fi/core'
import { LineChart } from '@budget-fi/ui'
import { useEffect, useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { money, moneyShort, monthOf, todayIso } from './format.ts'
import { hrefFor } from './route.ts'
import {
  ageLabel,
  monthYear,
  parseRetirementForm,
  retirementFormOf,
  timeUntil,
  type RetirementForm,
} from './retirement-text.ts'

/**
 * Where the retirement accounts end up at the target age, from their value today, a monthly
 * contribution and a return, all in today's dollars so the number means what it would buy now.
 */
export function RetirementCard({ today }: { today: Date }) {
  const asOf = monthOf(todayIso(today))
  const refresh = useRefresh()
  const projection = useBudgetQuery(() => budget.getRetirementProjection({ asOf }), [asOf])
  const data = projection.data
  const saved = data?.settings
  const [form, setForm] = useState<RetirementForm | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (saved) setForm(retirementFormOf(saved))
  }, [saved?.returnRate, saved?.inflationRate])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!form) return
    setError(null)
    const parsed = parseRetirementForm(form)
    if (!parsed.ok) return setError(parsed.error)
    try {
      await budget.setRetirementSettings({
        ...(await budget.getRetirementSettings()),
        ...parsed.settings,
      })
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const set = (patch: Partial<RetirementForm>) => form && setForm({ ...form, ...patch })
  const points = data?.points ?? []

  return (
    <section className="card" aria-label="Retirement projection">
      <h2>Retirement projection</h2>

      {data && data.problem === null && data.projected !== null && (
        <>
          <p className="hero-figure">
            <strong>{money(data.projected)}</strong>
            <small className="muted">
              {' '}
              when {data.reference?.name} retires at {data.targetAge}
              {data.monthsToTarget ? `, in ${timeUntil(data.monthsToTarget)}` : ''}, in today’s
              dollars
            </small>
          </p>
          <dl className="fund-figures">
            <dt>Retirement accounts today</dt>
            <dd>{money(data.startingBalance)}</dd>
            <dt>Still to contribute (everyone)</dt>
            <dd>{money(data.contributed)}</dd>
            <dt>Growth after inflation</dt>
            <dd className={data.growth < 0 ? 'negative' : undefined}>{money(data.growth)}</dd>
          </dl>
          {points.length > 1 && (
            <LineChart
              ariaLabel={`Projected retirement portfolio from ${monthYear(points[0]!.month)} to ${monthYear(points[points.length - 1]!.month)}`}
              labels={points.map((p) => String(p.month.slice(0, 4)))}
              detailLabels={points.map((p) => `Age ${ageLabel(p.age)} · ${monthYear(p.month)}`)}
              series={[
                {
                  label: 'Projected portfolio',
                  values: points.map((p) => p.balance),
                  color: 'var(--series-1)',
                },
                {
                  label: 'Savings with no growth',
                  values: points.map((p) => data.startingBalance + p.contributed),
                  color: 'var(--series-2)',
                },
              ]}
              formatValue={money}
              formatTick={moneyShort}
            />
          )}
          {points.length > 1 && (
            <details>
              <summary>Show as a table</summary>
              <div className="table-wrap">
                <table className="report-table">
                  <thead>
                    <tr>
                      <th scope="col">Age</th>
                      <th scope="col">Month</th>
                      <th scope="col" className="num">
                        Contributed
                      </th>
                      <th scope="col" className="num">
                        Portfolio
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((p) => (
                      <tr key={p.month}>
                        <th scope="row">{ageLabel(p.age)}</th>
                        <td>{monthYear(p.month)}</td>
                        <td className="num">{money(p.contributed)}</td>
                        <td className="num">{money(p.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {data.monthsToTarget === 0 && (
            <p className="muted">
              Everyone has reached their retirement age, so this is what the accounts hold today.
            </p>
          )}
        </>
      )}
      {data && data.problem !== null && (
        <p className="muted">
          {data.problem} <a href={hrefFor.settingsSection('profiles')}>Open Profiles</a>.
        </p>
      )}
      {data && data.accounts.length === 0 && (
        <p className="warn" role="status">
          No retirement accounts yet. Add an investment account of type IRA, 401(k) or another
          retirement plan and record its value.
        </p>
      )}

      {data && data.people.length > 0 && (
        <div className="table-wrap">
          <table className="report-table" aria-label="People in the plan">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Retires</th>
                <th scope="col" className="num">
                  Contributes a month
                </th>
                <th scope="col" className="num">
                  Income a year
                </th>
              </tr>
            </thead>
            <tbody>
              {data.people.map((p) => (
                <tr key={p.memberId}>
                  <th scope="row">{p.name}</th>
                  <td>
                    {p.retirementAge}
                    <span className="muted"> ({monthYear(p.retirementMonth)})</span>
                  </td>
                  <td className="num">{money(p.monthlyContribution)}</td>
                  <td className="num">{p.annualIncome > 0 ? money(p.annualIncome) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.skipped.map((s) => (
        <p key={s.memberId} className="muted">
          {s.name}: {s.note}
        </p>
      ))}
      {data && (
        <p className="muted">
          Each person’s birth month, retirement age, contribution and income are on their{' '}
          <a href={hrefFor.settingsSection('profiles')}>profile</a>.
        </p>
      )}

      {form && (
        <form
          className="inline wrap"
          noValidate
          aria-label="Retirement assumptions"
          onSubmit={(e) => void save(e)}
        >
          <label>
            Return a year (%)
            <input
              type="number"
              aria-label="Yearly return"
              min={RETURN_RATE_RANGE.min}
              max={RETURN_RATE_RANGE.max}
              step="any"
              value={form.returnRate}
              onChange={(e) => set({ returnRate: e.target.value })}
            />
          </label>
          <label>
            Inflation a year (%)
            <input
              type="number"
              aria-label="Yearly inflation"
              min={INFLATION_RATE_RANGE.min}
              max={INFLATION_RATE_RANGE.max}
              step="any"
              value={form.inflationRate}
              onChange={(e) => set({ inflationRate: e.target.value })}
            />
          </label>
          <button type="submit">Save</button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {projection.error && (
        <p className="error" role="alert">
          {projection.error.message}
        </p>
      )}

      {data && data.accounts.length > 0 && (
        <p className="muted">
          Counts {data.accounts.map((a) => `${a.name} (${money(a.value)})`).join(', ')}. Only IRAs,
          401(k)s and the other retirement plans count; a taxable brokerage and 529s don’t.
        </p>
      )}
      {data && data.recentMonthlyContribution > 0 && (
        <p className="muted">
          Over the last 12 months about {money(data.recentMonthlyContribution)} a month was
          transferred into them. Payroll deductions don’t show as transfers, so count those in each
          person’s contribution too.
        </p>
      )}
      <p className="muted">
        Everyone’s accounts are projected together to the month the last of you retires. Each
        person’s contribution stops when they retire. The portfolio grows at the return after
        inflation and contributions stay the same in today’s dollars, unless a profile lets them
        grow with raises. Real returns vary year to year; this is a steady-return estimate, not a
        forecast.
      </p>
    </section>
  )
}
