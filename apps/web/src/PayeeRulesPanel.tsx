import { useState } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'

/** Payees that are put in a category as soon as they are imported from the bank. */
export function PayeeRulesPanel() {
  const refresh = useRefresh()
  const rules = useBudgetQuery(() => budget.listPayeeRules())
  const groups = useBudgetQuery(() => budget.listCategoryGroups())
  const [match, setMatch] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const names = new Map(
    (groups.data ?? []).flatMap((g) => g.categories.map((c) => [c.id, `${g.name}: ${c.name}`])),
  )

  async function run(fn: () => Promise<void>) {
    setError(null)
    setNote(null)
    try {
      await fn()
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const add = () =>
    run(async () => {
      await budget.createPayeeRule({ match, categoryId })
      setMatch('')
      const changed = await budget.applyPayeeRules()
      if (changed > 0)
        setNote(`${changed} waiting in the inbox ${changed === 1 ? 'was' : 'were'} categorized.`)
    })

  return (
    <section className="card">
      <h2>Payee rules</h2>
      <p className="muted">
        When a bank transaction’s payee contains the words below, it arrives in the inbox already in
        that category. You still approve each one.
      </p>
      {rules.data?.length === 0 && (
        <p className="muted">No rules yet. Add one here, or from the inbox.</p>
      )}
      <ul className="plain">
        {rules.data?.map((r) => (
          <li key={r.id} className="row">
            <span>
              <strong>{r.match}</strong> →{' '}
              {names.get(r.categoryId) ?? 'a category that was removed'}
            </span>
            <button
              type="button"
              className="secondary danger"
              aria-label={`Delete the rule for ${r.match}`}
              onClick={() => void run(() => budget.deletePayeeRule(r.id))}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <label>
          Payee contains
          <input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="Kroger" />
        </label>
        <label>
          Category
          <select
            aria-label="Category for the new rule"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">Choose…</option>
            {(groups.data ?? [])
              .filter((g) => !g.hidden)
              .map((g) => (
                <optgroup key={g.id} label={g.name}>
                  {g.categories
                    .filter((c) => !c.hidden && !c.creditCardAccountId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </optgroup>
              ))}
          </select>
        </label>
        <div className="row">
          <button type="submit" disabled={!match.trim() || !categoryId}>
            Add rule
          </button>
        </div>
      </form>
      {note && <p role="status">{note}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
