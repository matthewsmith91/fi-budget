import type { ActivityEvent, ActivityPage } from '@budget-fi/core'
import { useState } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery } from './data.ts'
import { messageOf } from './errors.ts'

const PAGE = 50

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function ActivityView() {
  const first = useBudgetQuery(() => budget.listActivity({ limit: PAGE }))
  // Older pages hang off the first page they were loaded under; a fresh first page drops them.
  const [loaded, setLoaded] = useState<{
    base: ActivityPage | undefined
    events: ActivityEvent[]
    next: string | null
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const current =
    loaded && loaded.base === first.data
      ? loaded
      : { base: first.data, events: [], next: first.data?.next ?? null }
  const older = current.events
  const next = current.next

  async function more() {
    if (!next) return
    setLoadingMore(true)
    setError(null)
    try {
      const page = await budget.listActivity({ limit: PAGE, before: next })
      setLoaded({ base: first.data, events: [...older, ...page.events], next: page.next })
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setLoadingMore(false)
    }
  }

  const events = [...(first.data?.events ?? []), ...older]

  return (
    <div className="page">
      <header className="page-header">
        <h1>Activity</h1>
      </header>
      {first.error && (
        <p className="error" role="alert">
          {first.error.message}
        </p>
      )}
      {!first.loading && events.length === 0 && <p className="empty">Nothing has happened yet.</p>}
      <ol className="activity" aria-label="Activity">
        {events.map((e) => (
          <li key={e.cursor} className={`activity-item ${e.kind}`}>
            <span className="activity-summary">{e.summary}</span>
            <span className="activity-meta muted">
              {e.memberName ?? e.deviceName ?? 'Unknown device'} · {when.format(new Date(e.at))}
            </span>
          </li>
        ))}
      </ol>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {next && (
        <p>
          <button
            type="button"
            className="secondary"
            disabled={loadingMore}
            onClick={() => void more()}
          >
            Show older
          </button>
        </p>
      )}
    </div>
  )
}
