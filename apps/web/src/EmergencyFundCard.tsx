import { COVERAGE_RANGE, WINDOW_RANGE, type EmergencyFundSettings } from '@budget-fi/core'
import { useEffect, useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { money, monthOf, todayIso } from './format.ts'

const range = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => min + i)

/**
 * The emergency fund: a budget category sized as months of coverage times the average month of Need
 * spending. The average runs through the report's `month`; the balance is today's.
 */
export function EmergencyFundCard({ month, today }: { month: string; today: Date }) {
  const asOf = monthOf(todayIso(today))
  const refresh = useRefresh()
  const fund = useBudgetQuery(() => budget.getEmergencyFund({ month, asOf }), [month, asOf])
  const groups = useBudgetQuery(() => budget.listCategoryGroups())
  const data = fund.data
  const saved = data?.settings

  const [categoryId, setCategoryId] = useState('')
  const [months, setMonths] = useState<number>(COVERAGE_RANGE.default)
  const [window, setWindow] = useState<number>(WINDOW_RANGE.default)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!saved) return
    setCategoryId(saved.categoryId ?? '')
    setMonths(saved.months)
    setWindow(saved.window)
  }, [saved?.categoryId, saved?.months, saved?.window])

  // A card's payment category is managed by the card, so it can't be the fund.
  const choices = (groups.data ?? [])
    .map((g) => ({
      ...g,
      categories: g.categories.filter(
        (c) => !c.creditCardAccountId && (!c.hidden || c.id === saved?.categoryId),
      ),
    }))
    .filter((g) => g.categories.length > 0)
  const chosen = choices.flatMap((g) => g.categories).find((c) => c.id === saved?.categoryId)

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const settings: EmergencyFundSettings = { categoryId: categoryId || null, months, window }
    try {
      await budget.setEmergencyFund(settings)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="card" aria-label="Emergency fund">
      <h2>Emergency fund</h2>

      {data && chosen && (
        <dl className="fund-figures">
          <dt>Category</dt>
          <dd>{chosen.name}</dd>
          <dt>Balance today</dt>
          <dd>{money(data.balance)}</dd>
          <dt>Target</dt>
          <dd>
            {money(data.target)}{' '}
            <span className="muted">
              ({data.settings.months} × {money(data.averageNeed)} a month)
            </span>
          </dd>
          <dt>Still to save</dt>
          <dd>{money(data.shortfall)}</dd>
          <dt>Months covered</dt>
          <dd>
            {data.monthsCovered === null ? (
              <span className="muted">No Need spending to measure against yet</span>
            ) : (
              <strong>{data.monthsCovered.toFixed(1)}</strong>
            )}
          </dd>
        </dl>
      )}
      {data && chosen && data.averagedMonths < data.settings.window && (
        <p className="muted">
          The average is over {data.averagedMonths} of the last {data.settings.window} months, since
          that is all the spending history there is.
        </p>
      )}
      {data && !chosen && (
        <p className="muted">
          Pick the category that is your emergency fund (add one in the budget first if you don’t
          have it). Its target becomes the months of coverage you choose times your average Need
          spending.
        </p>
      )}

      <form className="inline" aria-label="Emergency fund settings" onSubmit={(e) => void save(e)}>
        <label>
          Category
          <select
            aria-label="Emergency fund category"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">None chosen</option>
            {choices.map((g) => (
              <optgroup key={g.id} label={g.name}>
                {g.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          Months of coverage
          <select
            aria-label="Months of coverage"
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
          >
            {range(COVERAGE_RANGE.min, COVERAGE_RANGE.max).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Average Need spending over
          <select
            aria-label="Averaging window"
            value={window}
            onChange={(e) => setWindow(Number(e.target.value))}
          >
            {range(WINDOW_RANGE.min, WINDOW_RANGE.max).map((n) => (
              <option key={n} value={n}>
                {n} months
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Save</button>
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </form>
      {fund.error && (
        <p className="error" role="alert">
          {fund.error.message}
        </p>
      )}
    </section>
  )
}
