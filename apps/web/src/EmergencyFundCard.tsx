import { COVERAGE_RANGE, WINDOW_RANGE, type CategoryRemoval } from '@budget-fi/core'
import { useEffect, useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { removalLines } from './category-text.ts'
import { messageOf } from './errors.ts'
import { money, monthLabel, monthOf, todayIso } from './format.ts'

/** "October 2026" */
const monthLabelText = (month: string) => {
  const l = monthLabel(month)
  return `${l.name} ${l.year}`
}

const range = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => min + i)

/**
 * The emergency fund: a budget category sized as months of coverage times the average month of Need
 * spending. The average runs through the report's `month`; the balance is today's. It is optional:
 * it can be started (as a new category, or from one the household already has) and deleted.
 */
export function EmergencyFundCard({ month, today }: { month: string; today: Date }) {
  const asOf = monthOf(todayIso(today))
  const refresh = useRefresh()
  const fund = useBudgetQuery(() => budget.getEmergencyFund({ month, asOf }), [month, asOf])
  const groups = useBudgetQuery(() => budget.listCategoryGroups())
  const data = fund.data
  const saved = data?.settings

  const [existing, setExisting] = useState('')
  const [months, setMonths] = useState<number>(COVERAGE_RANGE.default)
  const [window, setWindow] = useState<number>(WINDOW_RANGE.default)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<CategoryRemoval | null>(null)
  useEffect(() => {
    if (!saved) return
    setMonths(saved.months)
    setWindow(saved.window)
  }, [saved?.months, saved?.window])

  // A card's payment category is managed by the card, so it can't be the fund.
  const choices = (groups.data ?? [])
    .map((g) => ({
      ...g,
      categories: g.categories.filter((c) => !c.creditCardAccountId && !c.hidden),
    }))
    .filter((g) => g.categories.length > 0)
  const chosen = (groups.data ?? [])
    .flatMap((g) => g.categories)
    .find((c) => c.id === saved?.categoryId)

  /** Runs a write, showing why it failed beside the buttons. */
  async function attempt(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!saved) return
    await attempt(() => budget.setEmergencyFund({ categoryId: saved.categoryId, months, window }))
  }

  async function askToDelete() {
    setError(null)
    if (!chosen) return
    try {
      setDeleting(await budget.planCategoryRemoval(chosen.id, { month: asOf }))
    } catch (err) {
      setError(messageOf(err))
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
        <>
          <p className="muted">
            An emergency fund is optional. Start one and it appears in the budget under Reserves,
            with a target of the months of coverage you choose times your average Need spending.
            Send income to it with an income rule; mark a transaction as an emergency to pay for it
            from the fund.
          </p>
          <div className="inline">
            <button
              type="button"
              onClick={() => void attempt(() => budget.createEmergencyFund({ months, window }))}
            >
              Create emergency fund
            </button>
          </div>
          {choices.length > 0 && (
            <form
              className="inline"
              aria-label="Use an existing category"
              onSubmit={(e) => {
                e.preventDefault()
                void attempt(() =>
                  budget.createEmergencyFund({ categoryId: existing, months, window }),
                )
              }}
            >
              <label>
                Or use a category you already have
                <select
                  aria-label="Existing category"
                  value={existing}
                  onChange={(e) => setExisting(e.target.value)}
                >
                  <option value="">Choose a category</option>
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
              <button type="submit" className="secondary" disabled={!existing}>
                Use it
              </button>
            </form>
          )}
        </>
      )}

      {data && chosen && (
        <form
          className="inline"
          aria-label="Emergency fund settings"
          onSubmit={(e) => void save(e)}
        >
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
        </form>
      )}

      {data && chosen && !deleting && (
        <p>
          <button type="button" className="link" onClick={() => void askToDelete()}>
            Delete emergency fund…
          </button>
        </p>
      )}
      {chosen && deleting && (
        <div className="sheet-confirm" role="group" aria-label="Delete emergency fund">
          {deleting.blocked ? (
            <p className="error" role="alert">
              {deleting.blocked}
            </p>
          ) : (
            removalLines(deleting, chosen.name, monthLabelText(asOf)).map((line) => (
              <p key={line}>{line}</p>
            ))
          )}
          <div className="inline">
            {!deleting.blocked && (
              <button
                type="button"
                className="secondary danger"
                onClick={() =>
                  void attempt(async () => {
                    await budget.deleteEmergencyFund({ month: asOf })
                    setDeleting(null)
                  })
                }
              >
                Delete emergency fund
              </button>
            )}
            <button type="button" className="secondary" onClick={() => setDeleting(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {fund.error && (
        <p className="error" role="alert">
          {fund.error.message}
        </p>
      )}
    </section>
  )
}
