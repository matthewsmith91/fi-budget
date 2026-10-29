import { matchPayeeRule } from '@budget-fi/core'
import type { Account, CategoryGroup, InboxItem, Transaction } from '@budget-fi/core'
import { useState } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { money, shortDate } from './format.ts'
import { useAsync } from './hooks.ts'
import { ruleTextFor } from './rule-text.ts'
import { suggestApi } from './suggest.ts'

const MAX_SUGGEST = 50

/** Transactions fetched from the bank that nobody has looked at yet. */
export function InboxView({ accounts }: { accounts: Account[] }) {
  const refresh = useRefresh()
  const inbox = useBudgetQuery(() => budget.listInbox())
  const groups = useBudgetQuery(() => budget.listCategoryGroups())
  const rules = useBudgetQuery(() => budget.listPayeeRules())
  const suggestions = useAsync(() => suggestApi.enabled().catch(() => false))
  const [suggested, setSuggested] = useState<Record<string, string>>({})
  const [suggesting, setSuggesting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const accountById = new Map(accounts.map((a) => [a.id, a]))
  const items = inbox.data ?? []

  async function run(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const categoryNames = new Map(
    (groups.data ?? []).flatMap((g) => g.categories.map((c) => [c.id, c.name])),
  )

  async function suggest() {
    setError(null)
    setSuggesting(true)
    try {
      const payees = [
        ...new Set(
          items.flatMap(({ transaction: t }) =>
            t.payee && t.splits.length === 1 && !t.splits[0]!.categoryId ? [t.payee] : [],
          ),
        ),
      ].slice(0, MAX_SUGGEST)
      if (payees.length === 0) return
      const categories = (groups.data ?? [])
        .filter((g) => !g.hidden)
        .flatMap((g) =>
          g.categories
            .filter((c) => !c.hidden && !c.creditCardAccountId)
            .map((c) => ({ id: c.id, name: c.name, group: g.name })),
        )
      setSuggested(await suggestApi.categories(payees, categories))
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setSuggesting(false)
    }
  }

  function remember(t: Transaction) {
    const categoryId = t.splits[0]?.categoryId
    if (!t.payee || !categoryId) return
    const match = prompt(
      `Put every payee containing these words in ${categoryNames.get(categoryId) ?? 'this category'}:`,
      ruleTextFor(t.payee),
    )?.trim()
    if (!match) return
    void run(async () => {
      await budget.createPayeeRule({ match, categoryId })
      await budget.applyPayeeRules()
    })
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Inbox</h1>
        {suggestions.data && (
          <button
            type="button"
            className="secondary"
            disabled={suggesting || items.length === 0}
            onClick={() => void suggest()}
          >
            {suggesting ? 'Asking…' : 'Suggest categories'}
          </button>
        )}
        <button
          type="button"
          disabled={items.length === 0}
          onClick={() =>
            void run(() => budget.approveTransactions(items.map((i) => i.transaction.id)))
          }
        >
          Approve all{items.length > 0 ? ` (${items.length})` : ''}
        </button>
      </header>
      <p className="muted">
        New transactions from your bank. Pick a category, then approve. Anything you remove stays
        removed the next time the bank is fetched.
        {suggestions.data &&
          ' “Suggest categories” sends the payee names (nothing else) to Claude for a guess.'}
      </p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="table-wrap">
        <table className="register">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Account</th>
              <th scope="col">Payee</th>
              <th scope="col">Category</th>
              <th scope="col" className="num">
                Outflow
              </th>
              <th scope="col" className="num">
                Inflow
              </th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <InboxRow
                key={item.transaction.id}
                item={item}
                account={accountById.get(item.transaction.accountId)}
                groups={groups.data ?? []}
                onCategory={(categoryId) =>
                  run(() => budget.updateTransaction(item.transaction.id, { categoryId }))
                }
                suggestion={
                  item.transaction.payee
                    ? categoryNames.get(suggested[item.transaction.payee] ?? '')
                    : undefined
                }
                suggestionId={
                  item.transaction.payee ? suggested[item.transaction.payee] : undefined
                }
                canRemember={
                  item.transaction.payee !== null &&
                  matchPayeeRule(rules.data ?? [], item.transaction.payee) === null
                }
                onRemember={() => remember(item.transaction)}
                onApprove={() => run(() => budget.approveTransactions([item.transaction.id]))}
                onRemove={() => {
                  if (!confirm('Remove this transaction? It won’t be imported again.')) return
                  void run(() => budget.deleteTransaction(item.transaction.id))
                }}
                onMerge={(intoId) => run(() => budget.mergeImport(item.transaction.id, intoId))}
              />
            ))}
          </tbody>
        </table>
        {!inbox.loading && items.length === 0 && (
          <p className="empty">
            Nothing to review. The server checks your bank once a day; you can also fetch it from{' '}
            <a href="#/settings/connections">Settings</a>.
          </p>
        )}
      </div>
    </div>
  )
}

function InboxRow(props: {
  item: InboxItem
  account: Account | undefined
  groups: CategoryGroup[]
  onCategory: (categoryId: string | null) => void
  /** Claude's guess for this payee, by name and id, when it was asked and had one. */
  suggestion: string | undefined
  suggestionId: string | undefined
  /** True when the payee has a category but no rule yet. */
  canRemember: boolean
  onRemember: () => void
  onApprove: () => void
  onRemove: () => void
  onMerge: (intoId: string) => void
}) {
  const { transaction: t, possibleDuplicates } = props.item
  const split = t.splits.length > 1
  const categoryId = t.splits[0]?.categoryId ?? ''
  const label = t.payee ?? 'transaction'
  return (
    <>
      <tr className="txn-row">
        <td data-label="Date">{shortDate(t.date)}</td>
        <td data-label="Account">{props.account?.name ?? ''}</td>
        <td data-label="Payee">{t.payee ?? ''}</td>
        <td data-label="Category">
          {split ? (
            `Split (${t.splits.length})`
          ) : (
            <select
              aria-label={`Category for ${label}`}
              value={categoryId}
              disabled={props.account?.onBudget === false}
              onChange={(e) => props.onCategory(e.target.value || null)}
            >
              <option value="">
                {props.account?.onBudget === false
                  ? '—'
                  : t.amount > 0
                    ? 'Inflow: Ready to Assign'
                    : 'Uncategorized'}
              </option>
              {props.groups
                .filter((g) => !g.hidden)
                .map((g) => (
                  <optgroup key={g.id} label={g.name}>
                    {g.categories
                      .filter((c) => !c.creditCardAccountId && (!c.hidden || c.id === categoryId))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
            </select>
          )}
          {!categoryId && props.suggestion && props.suggestionId && !split && (
            <div className="muted">
              Suggested: {props.suggestion}{' '}
              <button
                type="button"
                className="secondary"
                aria-label={`Use the suggested category for ${label}`}
                onClick={() => props.onCategory(props.suggestionId!)}
              >
                Use
              </button>
            </div>
          )}
          {categoryId && props.canRemember && !split && (
            <div>
              <button
                type="button"
                className="secondary"
                aria-label={`Always use this category for ${label}`}
                onClick={props.onRemember}
              >
                Always do this
              </button>
            </div>
          )}
        </td>
        <td className="num" data-label="Outflow">
          {t.amount < 0 ? money(-t.amount) : ''}
        </td>
        <td className="num" data-label="Inflow">
          {t.amount > 0 ? money(t.amount) : ''}
        </td>
        <td>
          <button type="button" aria-label={`Approve ${label}`} onClick={props.onApprove}>
            Approve
          </button>{' '}
          <button
            type="button"
            className="secondary danger"
            aria-label={`Remove ${label}`}
            onClick={props.onRemove}
          >
            Remove
          </button>
        </td>
      </tr>
      {possibleDuplicates.slice(0, 3).map((d) => (
        <DuplicateRow key={d.id} entry={d} onMerge={() => props.onMerge(d.id)} />
      ))}
    </>
  )
}

function DuplicateRow({ entry, onMerge }: { entry: Transaction; onMerge: () => void }) {
  return (
    <tr className="duplicate-row">
      <td colSpan={7}>
        <span className="muted">
          You entered {entry.payee ? `“${entry.payee}”` : 'a transaction'} for{' '}
          {money(Math.abs(entry.amount))} on {shortDate(entry.date)}. Same purchase?
        </span>{' '}
        <button type="button" className="secondary" onClick={onMerge}>
          Merge into it
        </button>
      </td>
    </tr>
  )
}
