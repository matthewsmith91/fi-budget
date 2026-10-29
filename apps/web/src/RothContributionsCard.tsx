import { parseCents, type RothMemberContribution } from '@budget-fi/core'
import { useState } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { money, todayIso } from './format.ts'

/** What each person has put into their Roth IRAs this year, against the annual limit. */
export function RothContributionsCard({ today }: { today: Date }) {
  const [year, setYear] = useState(() => Number(todayIso(today).slice(0, 4)))
  const report = useBudgetQuery(() => budget.getRothContributions(year), [year])
  const data = report.data

  return (
    <section className="card" aria-label="Roth IRA contributions">
      <header className="card-header">
        <h2>Roth IRA contributions</h2>
        <div className="month-nav">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous year"
            onClick={() => setYear(year - 1)}
          >
            ‹
          </button>
          <span className="report-month">{year}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Next year"
            onClick={() => setYear(year + 1)}
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
      {data && data.members.length === 0 && data.unowned.length === 0 && (
        <p className="muted">
          No Roth IRA yet. Add an investment account of type IRA, tax type Roth, and choose whose it
          is.
        </p>
      )}
      {data?.members.map((m) => (
        <MemberRow key={m.memberId} member={m} />
      ))}
      {data && data.unowned.length > 0 && (
        <p className="warn" role="status">
          {data.unowned.map((a) => a.name).join(', ')} {data.unowned.length === 1 ? 'has' : 'have'}{' '}
          no owner, so {data.unowned.length === 1 ? 'its' : 'their'} contributions count toward no
          one’s limit. Choose an owner in the account’s settings.
        </p>
      )}
      <p className="muted">
        Counts money transferred in from a non-investment account, by the transfer’s date, cleared
        or not. A move from another investment account is a rollover or conversion and isn’t
        counted. The limit is the IRS limit for one person’s IRAs; change it for a catch-up
        contribution or an income phase-out.
      </p>
    </section>
  )
}

function MemberRow({ member: m }: { member: RothMemberContribution }) {
  const refresh = useRefresh()
  const [editing, setEditing] = useState(false)
  const [limit, setLimit] = useState('')
  const [error, setError] = useState<string | null>(null)
  const percent = m.limit > 0 ? Math.min(100, Math.round((m.contributed * 100) / m.limit)) : 100

  async function save(next: number | null) {
    setError(null)
    try {
      await budget.setContributionLimit({ memberId: m.memberId, year: m.year, limit: next })
      setEditing(false)
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <div className="stack stretch">
      <div className="row spread">
        <strong>{m.displayName}</strong>
        <span className={m.over ? 'negative' : undefined}>
          {money(m.contributed)} of {money(m.limit)}
        </span>
      </div>
      <progress
        max={100}
        value={percent}
        aria-label={`${m.displayName}’s ${m.year} Roth IRA contributions`}
      />
      <small className={m.over ? 'negative' : 'muted'}>
        {m.over
          ? `${money(-m.remaining)} over the limit`
          : m.remaining === 0
            ? 'At the limit'
            : `${money(m.remaining)} left`}
        {m.accounts.length > 1 && ` · ${m.accounts.map((a) => a.name).join(', ')}`}
        {m.isDefaultLimit ? ' · standard limit' : ' · your limit'}
      </small>
      {editing ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            const cents = parseCents(limit)
            if (cents === null || cents < 0) return setError('Enter the limit like 8,600.00')
            void save(cents)
          }}
        >
          <input
            aria-label={`${m.displayName}’s limit for ${m.year}`}
            inputMode="decimal"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
          <button type="submit">Save limit</button>
          {!m.isDefaultLimit && (
            <button type="button" className="secondary" onClick={() => void save(null)}>
              Use standard limit
            </button>
          )}
          <button type="button" className="secondary" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="row">
          <button
            type="button"
            className="secondary"
            aria-label={`Change ${m.displayName}’s limit for ${m.year}`}
            onClick={() => {
              setLimit((m.limit / 100).toFixed(2))
              setEditing(true)
            }}
          >
            Change limit
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
