import { type ReviewSuggestion } from '@budget-fi/core'
import { useState } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { money, monthLabel, monthOf, shiftMonth, todayIso } from './format.ts'

const NOTE = 'Monthly review'

/** What went over, what is underfunded, and moves that fix both, one press each. */
export function ReviewView({ today, month: start }: { today: Date; month: string | null }) {
  const refresh = useRefresh()
  const [month, setMonth] = useState(() => start ?? monthOf(todayIso(today)))
  const review = useBudgetQuery(() => budget.getMonthlyReview({ month }), [month])
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const label = monthLabel(month)
  const data = review.data

  async function apply(list: readonly ReviewSuggestion[]) {
    setError(null)
    setApplying(true)
    try {
      for (const s of list) {
        if (s.fromCategoryId === null) {
          await budget.allocate({
            month,
            categoryId: s.toCategoryId,
            goalId: s.toGoalId ?? undefined,
            amount: s.amount,
            note: NOTE,
          })
        } else {
          await budget.moveAllocation({
            month,
            fromCategoryId: s.fromCategoryId,
            toCategoryId: s.toCategoryId,
            toGoalId: s.toGoalId ?? undefined,
            amount: s.amount,
            note: NOTE,
          })
        }
      }
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setApplying(false)
      refresh()
    }
  }

  const nothing =
    data &&
    data.overspent.length === 0 &&
    data.underfunded.length === 0 &&
    data.overAllocated.length === 0 &&
    (data.emergencyFund === null || data.emergencyFund.shortfall === 0)

  return (
    <div className="page">
      <header className="page-header">
        <h1>Monthly review</h1>
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
            {label.name} <span className="muted">{label.year}</span>
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

      {review.error && (
        <p className="error" role="alert">
          {review.error.message}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {data && (
        <>
          <section className="card" aria-label="Month at a glance">
            <h2>At a glance</h2>
            <dl className="fund-figures">
              <dt>Ready to Assign</dt>
              <dd className={data.readyToAssign < 0 ? 'negative' : undefined}>
                {money(data.readyToAssign)}
              </dd>
              <dt>Assigned this month</dt>
              <dd>{money(data.assigned)}</dd>
              <dt>Spent this month</dt>
              <dd>{money(data.spent)}</dd>
            </dl>
            {data.readyToAssign < 0 && (
              <p className="warn" role="status">
                More is assigned than there is money. Take some back from a category.
              </p>
            )}
            {nothing && data.readyToAssign >= 0 && (
              <p role="status">
                <strong>Nothing needs fixing.</strong> No category went over and every goal is on
                track.
              </p>
            )}
          </section>

          {data.overspent.length > 0 && (
            <section className="card" aria-label="Went over">
              <h2>Went over</h2>
              <ul className="plain stack stretch">
                {data.overspent.map((o) => (
                  <li key={o.categoryId} className="row spread">
                    <span>{o.name}</span>
                    <span className="negative">{money(o.amount)} over</span>
                  </li>
                ))}
              </ul>
              <p className="muted">
                Cash overspending doesn’t carry into next month; it comes out of next month’s Ready
                to Assign. Covering it now keeps that month clean.
              </p>
            </section>
          )}

          {data.underfunded.length > 0 && (
            <section className="card" aria-label="Underfunded goals">
              <h2>Underfunded goals</h2>
              <ul className="plain stack stretch">
                {data.underfunded.map((g) => (
                  <li key={g.goalId} className="stack stretch">
                    <div className="row spread">
                      <span>
                        {g.categoryName}: {g.name}
                      </span>
                      <span>{money(g.shortBy)} short this month</span>
                    </div>
                    <progress max={100} value={g.percentFunded} aria-label={`${g.name} funded`} />
                    <small className="muted">
                      Needs {money(g.monthlyNeeded)} a month to be funded on time; {g.percentFunded}
                      % there.
                    </small>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(data.overAllocated.length > 0 ||
            (data.emergencyFund !== null && data.emergencyFund.shortfall > 0)) && (
            <section className="card" aria-label="Other things to look at">
              <h2>Worth a look</h2>
              {data.overAllocated.map((a) => (
                <p key={a.accountId} className="warn" role="status">
                  Goals held in {a.name} add up to {money(a.held)}, but the account has{' '}
                  {money(a.balance)}: {money(a.over)} of that money isn’t there.
                </p>
              ))}
              {data.emergencyFund !== null && data.emergencyFund.shortfall > 0 && (
                <p>
                  The emergency fund is {money(data.emergencyFund.shortfall)} below its{' '}
                  {money(data.emergencyFund.target)} target
                  {data.emergencyFund.monthsCovered !== null
                    ? `, covering ${data.emergencyFund.monthsCovered.toFixed(1)} months`
                    : ''}
                  . It is never used to cover other categories here.
                </p>
              )}
            </section>
          )}

          {(data.suggestions.length > 0 || data.uncovered > 0) && (
            <section className="card" aria-label="Suggested moves">
              <header className="card-header">
                <h2>Suggested moves</h2>
                {data.suggestions.length > 1 && (
                  <button
                    type="button"
                    disabled={applying}
                    onClick={() => void apply(data.suggestions)}
                  >
                    Apply all
                  </button>
                )}
              </header>
              {data.suggestions.length > 0 && (
                <ul className="plain stack stretch">
                  {data.suggestions.map((s, i) => (
                    <li key={i} className="row spread">
                      <span>
                        Move <strong>{money(s.amount)}</strong> from {s.fromName} to {s.toName}
                        <small className="muted">
                          {s.reason === 'overspent' ? ' (covers overspending)' : ' (funds a goal)'}
                        </small>
                      </span>
                      <button type="button" disabled={applying} onClick={() => void apply([s])}>
                        Apply
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {data.uncovered > 0 && (
                <p className="warn" role="status">
                  {money(data.uncovered)} of the overspending can’t be covered from what is spare.
                  Assign more money or move it from a category yourself.
                </p>
              )}
              <p className="muted">
                Overspending is covered from Ready to Assign first, then from other categories’
                unassigned money, wants before needs. Goals take what Ready to Assign has left.
                Money held for a goal, the emergency fund and hidden categories are left alone.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  )
}
