import type { CategoryGroup } from '@budget-fi/core'
import { useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { messageOf } from './errors.ts'
import { useAsync } from './hooks.ts'

type Run = (fn: () => Promise<unknown>) => Promise<void>

function moved<T>(items: T[], from: number, by: -1 | 1): T[] {
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(from + by, 0, item!)
  return next
}

export function CategoriesPanel() {
  const groups = useAsync(() => budget.listCategoryGroups())
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const run: Run = async (fn) => {
    setError(null)
    try {
      await fn()
      groups.reload()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  async function addGroup(e: FormEvent) {
    e.preventDefault()
    await run(async () => {
      await budget.createCategoryGroup({ name })
      setName('')
    })
  }

  const list = groups.data ?? []

  return (
    <section aria-labelledby="categories-heading">
      <h2 id="categories-heading">Categories</h2>
      {groups.data?.length === 0 && <p className="muted">No category groups yet.</p>}
      {list.map((g, i) => (
        <GroupBlock
          key={g.id}
          group={g}
          groups={list}
          run={run}
          onUp={
            i > 0 ? () => budget.reorderCategoryGroups(moved(list, i, -1).map((x) => x.id)) : null
          }
          onDown={
            i < list.length - 1
              ? () => budget.reorderCategoryGroups(moved(list, i, 1).map((x) => x.id))
              : null
          }
        />
      ))}
      <form onSubmit={(e) => void addGroup(e)}>
        <label>
          Group name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <button type="submit">Add group</button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  )
}

function GroupBlock(props: {
  group: CategoryGroup
  groups: CategoryGroup[]
  run: Run
  onUp: (() => Promise<unknown>) | null
  onDown: (() => Promise<unknown>) | null
}) {
  const { group, groups, run } = props
  const [name, setName] = useState('')

  async function addCategory(e: FormEvent) {
    e.preventDefault()
    await run(async () => {
      await budget.createCategory({ groupId: group.id, name })
      setName('')
    })
  }

  return (
    <div className={group.hidden ? 'group closed' : 'group'}>
      <h3>
        <span className="grow">
          {group.name}
          {group.hidden && <small className="muted"> · hidden</small>}
        </span>
        <button
          className="secondary"
          disabled={!props.onUp}
          aria-label={`Move ${group.name} up`}
          onClick={() => void run(props.onUp!)}
        >
          ↑
        </button>
        <button
          className="secondary"
          disabled={!props.onDown}
          aria-label={`Move ${group.name} down`}
          onClick={() => void run(props.onDown!)}
        >
          ↓
        </button>
        <button
          className="secondary"
          onClick={() => {
            const next = prompt('Rename group', group.name)
            if (next !== null) void run(() => budget.updateCategoryGroup(group.id, { name: next }))
          }}
        >
          Rename
        </button>
        <button
          className="secondary"
          onClick={() =>
            void run(() => budget.updateCategoryGroup(group.id, { hidden: !group.hidden }))
          }
        >
          {group.hidden ? 'Show' : 'Hide'}
        </button>
        <button
          className="secondary"
          onClick={() => {
            if (confirm(`Delete group ${group.name}?`)) {
              void run(() => budget.deleteCategoryGroup(group.id))
            }
          }}
        >
          Delete
        </button>
      </h3>
      <ul className="items">
        {group.categories.map((c, i, all) => (
          <li key={c.id} className={c.hidden ? 'closed' : undefined}>
            <span className="grow">
              {c.name}{' '}
              <small className="muted">
                {c.needOrWant}
                {c.hidden ? ' · hidden' : ''}
              </small>
            </span>
            <button
              className="secondary"
              disabled={i === 0}
              aria-label={`Move ${c.name} up`}
              onClick={() =>
                void run(() =>
                  budget.reorderCategories(
                    group.id,
                    moved(all, i, -1).map((x) => x.id),
                  ),
                )
              }
            >
              ↑
            </button>
            <button
              className="secondary"
              disabled={i === all.length - 1}
              aria-label={`Move ${c.name} down`}
              onClick={() =>
                void run(() =>
                  budget.reorderCategories(
                    group.id,
                    moved(all, i, 1).map((x) => x.id),
                  ),
                )
              }
            >
              ↓
            </button>
            <button
              className="secondary"
              onClick={() =>
                void run(() =>
                  budget.updateCategory(c.id, {
                    needOrWant: c.needOrWant === 'need' ? 'want' : 'need',
                  }),
                )
              }
            >
              Make {c.needOrWant === 'need' ? 'want' : 'need'}
            </button>
            <select
              aria-label={`Group for ${c.name}`}
              value={group.id}
              onChange={(e) =>
                void run(() => budget.updateCategory(c.id, { groupId: e.target.value }))
              }
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <button
              className="secondary"
              onClick={() => {
                const next = prompt('Rename category', c.name)
                if (next !== null) void run(() => budget.updateCategory(c.id, { name: next }))
              }}
            >
              Rename
            </button>
            <button
              className="secondary"
              onClick={() => void run(() => budget.updateCategory(c.id, { hidden: !c.hidden }))}
            >
              {c.hidden ? 'Show' : 'Hide'}
            </button>
            <button
              className="secondary"
              onClick={() => {
                if (confirm(`Delete ${c.name}?`)) void run(() => budget.deleteCategory(c.id))
              }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      <form className="inline" onSubmit={(e) => void addCategory(e)}>
        <input
          aria-label={`New category in ${group.name}`}
          placeholder="New category"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button type="submit">Add</button>
      </form>
    </div>
  )
}
