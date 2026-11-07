import { type Category, type CategoryGroup, type CategoryRemoval } from '@budget-fi/core'
import { useState, type FormEvent, type ReactNode } from 'react'
import { budget } from './client.ts'
import { removalLines } from './category-text.ts'
import { useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { money } from './format.ts'
import { retirementTag } from './retirement-text.ts'
import { Sheet } from './Sheet.tsx'

export interface Figures {
  assigned: number
  activity: number
  available: number
}

/** Runs a write, refreshes the views, and reports failure in the sheet, beside what was pressed. */
function useAct() {
  const refresh = useRefresh()
  const [error, setError] = useState<string | null>(null)
  async function act(fn: () => Promise<unknown>): Promise<boolean> {
    setError(null)
    try {
      await fn()
      refresh()
      return true
    } catch (err) {
      setError(messageOf(err))
      return false
    }
  }
  return { error, setError, act }
}

function RenameForm(props: { label: string; name: string; onRename: (name: string) => void }) {
  const [name, setName] = useState(props.name)
  function submit(e: FormEvent) {
    e.preventDefault()
    props.onRename(name)
  }
  return (
    <form className="sheet-rename" onSubmit={submit}>
      <label>
        {props.label}
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <button type="submit" className="secondary" disabled={name.trim() === props.name}>
        Rename
      </button>
    </form>
  )
}

function Errors({ error }: { error: string | null }) {
  return (
    error && (
      <p className="error" role="alert">
        {error}
      </p>
    )
  )
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="sheet-actions">{children}</div>
}

/** Everything you can do to one category, in one place that works under a thumb. */
export function CategorySheet(props: {
  category: Category
  /** The group's categories in their real order, hidden ones included. */
  inGroup: Category[]
  /** The ones shown, so a move steps over the hidden ones. */
  shown: Category[]
  /** Null while this month's figures are loading. */
  figures: Figures | null
  month: string
  monthName: string
  onAddGoal: () => void
  onRetirement: () => void
  onClose: () => void
}) {
  const { category: c, figures } = props
  const { error, setError, act } = useAct()
  const [plan, setPlan] = useState<CategoryRemoval | null>(null)
  // A card's payment category follows the card, so it can be hidden but not renamed or removed.
  const managed = c.creditCardAccountId !== null
  const at = props.shown.findIndex((x) => x.id === c.id)

  function move(by: -1 | 1) {
    const other = props.shown[at + by]
    if (!other) return
    const ids = props.inGroup.map((x) => x.id)
    const a = ids.indexOf(c.id)
    const b = ids.indexOf(other.id)
    ;[ids[a], ids[b]] = [ids[b]!, ids[a]!]
    return act(() => budget.reorderCategories(c.groupId, ids))
  }

  async function review() {
    setError(null)
    try {
      const next = await budget.planCategoryRemoval(c.id, { month: props.month })
      if (next.blocked) setError(next.blocked)
      else setPlan(next)
    } catch (err) {
      setError(messageOf(err))
    }
  }

  async function remove() {
    if (await act(() => budget.removeCategory(c.id, { month: props.month }))) props.onClose()
  }

  const tag = retirementTag(c.retirementStatus, c.retirementMultiplier)
  return (
    <Sheet title={c.name} onClose={props.onClose}>
      <p className="muted sheet-tags">
        {c.needOrWant === 'need' ? 'Need' : 'Want'}
        {tag && ` · ${tag} in retirement`}
        {c.hidden && ' · Hidden'}
      </p>
      <dl className="sheet-figures">
        <div>
          <dt>Assigned</dt>
          <dd>{figures ? money(figures.assigned) : '—'}</dd>
        </div>
        <div>
          <dt>Activity</dt>
          <dd>{figures ? money(figures.activity) : '—'}</dd>
        </div>
        <div>
          <dt>Available</dt>
          <dd>{figures ? money(figures.available) : '—'}</dd>
        </div>
      </dl>

      {plan ? (
        <section className="sheet-confirm" aria-label={`Remove ${c.name}`}>
          {removalLines(plan, c.name, props.monthName).map((line) => (
            <p key={line}>{line}</p>
          ))}
          <Errors error={error} />
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={() => setPlan(null)}>
              Cancel
            </button>
            <button type="button" className="secondary danger" onClick={() => void remove()}>
              Remove {c.name}
            </button>
          </div>
        </section>
      ) : (
        <>
          {!managed && (
            <RenameForm
              key={c.name}
              label="Name"
              name={c.name}
              onRename={(name) => void act(() => budget.updateCategory(c.id, { name }))}
            />
          )}
          <Actions>
            {!managed && (
              <button type="button" className="secondary" onClick={props.onAddGoal}>
                Add goal
              </button>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() =>
                void act(() =>
                  budget.updateCategory(c.id, {
                    needOrWant: c.needOrWant === 'need' ? 'want' : 'need',
                  }),
                )
              }
            >
              {c.needOrWant === 'need' ? 'Mark as want' : 'Mark as need'}
            </button>
            {!managed && (
              <button type="button" className="secondary" onClick={props.onRetirement}>
                In retirement…
              </button>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => void act(() => budget.updateCategory(c.id, { hidden: !c.hidden }))}
            >
              {c.hidden ? 'Show' : 'Hide'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={at <= 0}
              onClick={() => void move(-1)}
            >
              Move up
            </button>
            <button
              type="button"
              className="secondary"
              disabled={at < 0 || at >= props.shown.length - 1}
              onClick={() => void move(1)}
            >
              Move down
            </button>
          </Actions>
          {!c.hidden && figures && figures.available !== 0 && (
            <p className="muted sheet-note">
              Hiding keeps the money in the category. Remove returns it to Ready to Assign.
            </p>
          )}
          <Errors error={error} />
          {!managed && (
            <div className="sheet-danger">
              <button type="button" className="secondary danger" onClick={() => void review()}>
                Remove…
              </button>
            </div>
          )}
        </>
      )}
    </Sheet>
  )
}

/** The same for a group; only an empty one can be deleted, so a full one can only be hidden. */
export function GroupSheet(props: {
  group: CategoryGroup
  all: CategoryGroup[]
  onAddCategory: () => void
  onClose: () => void
}) {
  const { group, all } = props
  const { error, act } = useAct()
  const [confirming, setConfirming] = useState(false)
  const position = all.findIndex((g) => g.id === group.id)

  function move(by: -1 | 1) {
    const ids = all.map((g) => g.id)
    ;[ids[position], ids[position + by]] = [ids[position + by]!, ids[position]!]
    return act(() => budget.reorderCategoryGroups(ids))
  }

  async function remove() {
    if (await act(() => budget.deleteCategoryGroup(group.id))) props.onClose()
  }

  return (
    <Sheet title={group.name} onClose={props.onClose}>
      {confirming ? (
        <section className="sheet-confirm" aria-label={`Delete ${group.name}`}>
          <p>{group.name} is empty. Deleting it can’t be undone.</p>
          <Errors error={error} />
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="secondary danger" onClick={() => void remove()}>
              Delete {group.name}
            </button>
          </div>
        </section>
      ) : (
        <>
          <RenameForm
            key={group.name}
            label="Group name"
            name={group.name}
            onRename={(name) => void act(() => budget.updateCategoryGroup(group.id, { name }))}
          />
          <Actions>
            <button type="button" className="secondary" onClick={props.onAddCategory}>
              Add category
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() =>
                void act(() => budget.updateCategoryGroup(group.id, { hidden: !group.hidden }))
              }
            >
              {group.hidden ? 'Show' : 'Hide'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={position <= 0}
              onClick={() => void move(-1)}
            >
              Move up
            </button>
            <button
              type="button"
              className="secondary"
              disabled={position >= all.length - 1}
              onClick={() => void move(1)}
            >
              Move down
            </button>
          </Actions>
          <Errors error={error} />
          <div className="sheet-danger">
            {group.categories.length === 0 ? (
              <button
                type="button"
                className="secondary danger"
                onClick={() => setConfirming(true)}
              >
                Delete…
              </button>
            ) : (
              <p className="muted">
                To delete this group, remove its categories first. Hide it to keep their history.
              </p>
            )}
          </div>
        </>
      )}
    </Sheet>
  )
}
