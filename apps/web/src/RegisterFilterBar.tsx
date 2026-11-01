import type { Account, CategoryGroup } from '@budget-fi/core'
import { useEffect, useRef, useState } from 'react'
import { isFiltered, NO_FILTER, type RegisterFilter } from './register-filter.ts'

/** Typing waits this long before it narrows the list (and, on All Accounts, rewrites the URL). */
const TYPING_PAUSE_MS = 250

/**
 * The search box keeps what is typed itself and reports it after a pause, so the caret doesn't
 * jump while the filter makes its way through the URL and back.
 */
function SearchBox(props: { value: string | null; onCommit: (text: string | null) => void }) {
  const [text, setText] = useState(props.value ?? '')
  const sent = useRef(props.value ?? '')
  const { onCommit } = props

  // Follow changes made elsewhere (Clear filters, a link), but not the echo of our own.
  useEffect(() => {
    const incoming = props.value ?? ''
    if (incoming !== sent.current) {
      sent.current = incoming
      setText(incoming)
    }
  }, [props.value])

  useEffect(() => {
    const wanted = text.trim()
    if (wanted === sent.current.trim()) return
    const timer = setTimeout(() => {
      sent.current = wanted
      onCommit(wanted || null)
    }, TYPING_PAUSE_MS)
    return () => clearTimeout(timer)
  }, [text, onCommit])

  return (
    <label className="filter-search">
      <span>Search</span>
      <input
        type="search"
        placeholder="Payee, category or amount"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // apply now instead of waiting out the pause
            sent.current = text.trim()
            onCommit(text.trim() || null)
          }
        }}
      />
    </label>
  )
}

/** Narrows a register. On All Accounts the filter lives in the URL; on one account it is local. */
export function RegisterFilterBar(props: {
  filter: RegisterFilter
  onChange: (patch: Partial<RegisterFilter>) => void
  groups: CategoryGroup[]
  /** Offered on All Accounts only; one account's register is already one account. */
  accounts?: Account[]
  summary: string | null
}) {
  const { filter, onChange } = props
  const unknownCategory =
    filter.categoryId !== null &&
    !props.groups.some((g) => g.categories.some((c) => c.id === filter.categoryId))
  return (
    <div className="filter-bar" role="search" aria-label="Filter transactions">
      <SearchBox value={filter.query} onCommit={(query) => onChange({ query })} />
      <label>
        <span>Category</span>
        <select
          value={filter.categoryId ?? ''}
          onChange={(e) => onChange({ categoryId: e.target.value || null })}
        >
          <option value="">All categories</option>
          {unknownCategory && <option value={filter.categoryId!}>Unknown category</option>}
          {props.groups.map((g) => {
            const categories = g.categories.filter(
              (c) => !c.creditCardAccountId && (!c.hidden || c.id === filter.categoryId),
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
      </label>
      {props.accounts && (
        <label>
          <span>Account</span>
          <select
            value={filter.accountId ?? ''}
            onChange={(e) => onChange({ accountId: e.target.value || null })}
          >
            <option value="">All accounts</option>
            {props.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.closed ? ' (closed)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        <span>From</span>
        <input
          type="date"
          value={filter.from ?? ''}
          max={filter.to ?? undefined}
          onChange={(e) => onChange({ from: e.target.value || null })}
        />
      </label>
      <label>
        <span>To</span>
        <input
          type="date"
          value={filter.to ?? ''}
          min={filter.from ?? undefined}
          onChange={(e) => onChange({ to: e.target.value || null })}
        />
      </label>
      {isFiltered(filter) && (
        <button type="button" className="secondary" onClick={() => onChange(NO_FILTER)}>
          Clear filters
        </button>
      )}
      {props.summary && (
        <span className="muted filter-summary" role="status">
          {props.summary}
        </span>
      )}
    </div>
  )
}
