import type { Account, Transaction } from '@budget-fi/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { InvestmentDetails } from './InvestmentDetails.tsx'
import { InvestmentGoals } from './InvestmentGoals.tsx'
import { budget } from './client.ts'
import { payeeOptions } from './combo-options.ts'
import { useConfirm, type ConfirmOptions } from './use-confirm.tsx'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { money, shortDate } from './format.ts'
import { Menu } from './Menu.tsx'
import {
  categoryTotal,
  filterHref,
  isFiltered,
  matchesFilter,
  NO_FILTER,
  searchText,
  type RegisterFilter,
} from './register-filter.ts'
import { RegisterFilterBar } from './RegisterFilterBar.tsx'
import { ReconcileDialog } from './ReconcileDialog.tsx'
import { RenameAccountSheet } from './RenameAccountSheet.tsx'
import { Skeleton } from './Skeleton.tsx'
import { TransactionRow } from './TransactionRow.tsx'
import { TransferDialog } from './TransferDialog.tsx'

/**
 * Rows drawn at a time. An imported history is thousands of transactions, and drawing them
 * all made every refresh (even toggling Cleared) take seconds.
 */
const PAGE_SIZE = 200

interface Props {
  /** Null shows every account. */
  accountId: string | null
  /** Only on All Accounts: what narrows the list, kept in the URL. */
  filter?: RegisterFilter
  accounts: Account[]
  accountsLoaded: boolean
  onAddAccount: () => void
}

export function RegisterView({
  accountId,
  filter = NO_FILTER,
  accounts,
  accountsLoaded,
  onAddAccount,
}: Props) {
  const refresh = useRefresh()
  const transactions = useBudgetQuery(
    () => budget.listTransactions(accountId ? { accountId } : undefined),
    [accountId],
  )
  const groups = useBudgetQuery(() => budget.listCategoryGroups())
  const goals = useBudgetQuery(() => budget.listGoals())
  const balances = useBudgetQuery(() => budget.getAccountBalances())
  const fundSettings = useBudgetQuery(() => budget.getEmergencyFundSettings())
  const hasFund = !!fundSettings.data?.categoryId
  const { ask, dialog: confirmDialog } = useConfirm()
  // The open editor, tied to the register it was opened in so switching accounts closes it.
  // 'new' is the blank entry row; otherwise the id of the transaction being edited.
  const scopeKey = accountId ?? ''
  const [edit, setEdit] = useState<{ scope: string; id: string | null }>({
    scope: scopeKey,
    id: null,
  })
  const editing = edit.scope === scopeKey ? edit.id : null
  // Whether the open editor holds typing that leaving would lose.
  const dirty = useRef(false)
  const setDirty = useCallback((value: boolean) => void (dirty.current = value), [])
  // A row to hand focus back to once its editor closes, so the keyboard doesn't lose its place.
  const returnFocusTo = useRef<string | null>(null)
  // Failures of writes made outside an editor (the Cleared toggle, the account menu).
  const [error, setError] = useState<string | null>(null)
  const [transferring, setTransferring] = useState(false)
  const [reconciling, setReconciling] = useState(false)
  const [renaming, setRenaming] = useState(false)
  // One account's register keeps its filter here; All Accounts keeps it in the URL.
  const [local, setLocal] = useState<{ scope: string; filter: RegisterFilter }>({
    scope: scopeKey,
    filter: NO_FILTER,
  })
  const activeFilter =
    accountId === null ? filter : local.scope === scopeKey ? local.filter : NO_FILTER
  // Tied to the account and filter so changing either starts from the newest rows again.
  const scope = `${scopeKey}|${filterHref(activeFilter)}`
  const [paging, setPaging] = useState({ scope, size: PAGE_SIZE })
  const shownCount = paging.scope === scope ? paging.size : PAGE_SIZE

  const account = accountId ? accounts.find((a) => a.id === accountId) : undefined
  const scoped = accountId ? (account ? [account] : []) : accounts.filter((a) => !a.closed)
  const showAccountColumn = accountId === null

  useEffect(() => {
    if (editing !== null || returnFocusTo.current === null) return
    const row = [...document.querySelectorAll<HTMLElement>('[data-txn]')].find(
      (el) => el.dataset.txn === returnFocusTo.current,
    )
    row?.querySelector<HTMLElement>('.row-open')?.focus()
    returnFocusTo.current = null
  }, [editing])

  const names = useMemo(
    () => ({
      category: new Map(
        (groups.data ?? []).flatMap((g) => g.categories.map((c) => [c.id, c.name] as const)),
      ),
      goal: new Map((goals.data ?? []).map((g) => [g.id, g.name] as const)),
      account: new Map(accounts.map((a) => [a.id, a] as const)),
    }),
    [groups.data, goals.data, accounts],
  )
  const payees = useMemo(
    () => payeeOptions((transactions.data ?? []).flatMap((t) => (t.payee ? [t.payee] : []))),
    [transactions.data],
  )

  // A split transaction shows whole; a category filter matches it on any of its lines.
  const shown = useMemo(() => {
    const all = transactions.data ?? []
    if (!isFiltered(activeFilter)) return all
    return all.filter((t) =>
      matchesFilter(
        t,
        activeFilter,
        activeFilter.query
          ? searchText(
              [
                payeeLabel(t, names.account),
                names.account.get(t.accountId)?.name,
                ...t.splits.flatMap((s) => [
                  s.categoryId ? names.category.get(s.categoryId) : null,
                  s.goalId ? names.goal.get(s.goalId) : null,
                ]),
              ],
              t.amount,
            )
          : undefined,
      ),
    )
  }, [transactions.data, activeFilter, names])

  if (accountId && accountsLoaded && !account) {
    return (
      <div className="page">
        <p className="empty">
          That account doesn’t exist. <a href="#/budget">Back to the budget</a>
        </p>
      </div>
    )
  }
  if (accountId === null && accountsLoaded && accounts.length === 0) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>All Accounts</h1>
        </header>
        <p className="empty">
          No accounts yet.{' '}
          <button type="button" className="link" onClick={onAddAccount}>
            Add your first account
          </button>{' '}
          to start recording transactions.
        </p>
      </div>
    )
  }

  const ids = new Set(scoped.map((a) => a.id))
  const mine = (balances.data ?? []).filter((b) => ids.has(b.accountId))
  const cleared = mine.reduce((n, b) => n + b.cleared, 0)
  const working = mine.reduce((n, b) => n + b.balance, 0)
  const balancesReady = balances.data !== undefined && (accountId === null || mine.length > 0)

  // Deposits an outflow can take back: income that landed in Ready to Assign.
  const deposits = (transactions.data ?? []).filter(
    (t) =>
      t.amount > 0 &&
      t.approved &&
      !t.transferPairId &&
      !t.reversesId &&
      t.splits.every((s) => !s.categoryId),
  )

  /** Opens an editor (or closes it with null), asking first if that would lose typing. */
  async function openEditor(next: string | null) {
    if (editing !== null && next !== editing && dirty.current) {
      const ok = await ask({
        title: 'Discard your changes?',
        message: <p>This transaction has changes that haven’t been saved.</p>,
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
        danger: true,
      })
      if (!ok) return
    }
    setError(null)
    dirty.current = false
    setEdit({ scope: scopeKey, id: next })
  }

  /** Closes the editor for good (saved, deleted or cancelled) and puts focus back on its row. */
  function closeEditor() {
    returnFocusTo.current = editing === 'new' ? null : editing
    dirty.current = false
    setEdit({ scope: scopeKey, id: null })
  }

  /** A write from outside an editor: a failure lands in the banner. */
  async function run(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  /** A write from inside an editor: it rejects so the editor can show why and stay open. */
  async function write(fn: () => Promise<unknown>) {
    await fn()
    refresh()
  }

  function changeFilter(patch: Partial<RegisterFilter>) {
    if (accountId === null) location.replace(filterHref({ ...filter, ...patch }))
    else setLocal({ scope: scopeKey, filter: { ...activeFilter, ...patch } })
  }

  const openAccounts = accounts.filter((a) => !a.closed)
  const canAdd = scoped.some((a) => !a.closed)
  const canTransfer = openAccounts.length >= 2
  const summary = transactions.loading
    ? null
    : `${shown.length.toLocaleString()} of ${(transactions.data?.length ?? 0).toLocaleString()} transactions` +
      (activeFilter.categoryId
        ? ` · ${money(categoryTotal(shown, activeFilter.categoryId))} in category`
        : '')

  return (
    <div className="page">
      <header className="page-header register-header">
        <div>
          <h1>{account ? account.name : 'All Accounts'}</h1>
          {account && (
            <span className="muted">
              {account.type}
              {account.onBudget ? '' : ' · tracking'}
              {account.closed ? ' · closed' : ''}
            </span>
          )}
        </div>
        <div className="balances" role="group" aria-label="Balances" aria-busy={!balancesReady}>
          <dl>
            <dt>Cleared</dt>
            <dd>{balancesReady ? money(cleared) : <Skeleton />}</dd>
          </dl>
          <span aria-hidden>+</span>
          <dl>
            <dt>Uncleared</dt>
            <dd>{balancesReady ? money(working - cleared) : <Skeleton />}</dd>
          </dl>
          <span aria-hidden>=</span>
          <dl>
            <dt>Working Balance</dt>
            <dd>{balancesReady ? money(working) : <Skeleton />}</dd>
          </dl>
        </div>
      </header>

      <div className="toolbar register-toolbar">
        <button type="button" disabled={!canAdd} onClick={() => void openEditor('new')}>
          + Add Transaction
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!canTransfer}
          onClick={() => setTransferring(true)}
        >
          + Add Transfer
        </button>
        {account && !account.closed && (
          <button type="button" className="secondary" onClick={() => setReconciling(true)}>
            Reconcile
          </button>
        )}
        {account?.type === 'investment' && <InvestmentGoals accountId={account.id} />}
        {account?.type === 'investment' && <InvestmentDetails accountId={account.id} />}
        {account && (
          <AccountMenu
            account={account}
            transactionCount={transactions.data?.length ?? null}
            run={run}
            ask={ask}
            onRename={() => setRenaming(true)}
          />
        )}
        {accountsLoaded && !canAdd && (
          <span className="muted toolbar-hint">
            This account is closed. Reopen it from the ⋯ menu to add transactions.
          </span>
        )}
        {accountsLoaded && canAdd && !canTransfer && (
          <span className="muted toolbar-hint">A transfer needs two open accounts.</span>
        )}
      </div>

      <RegisterFilterBar
        filter={activeFilter}
        onChange={changeFilter}
        groups={groups.data ?? []}
        accounts={accountId === null ? accounts : undefined}
        summary={
          summary && isFiltered(activeFilter)
            ? `${summary} · balances above include every transaction`
            : summary
        }
      />

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {transactions.error && (
        <div className="banner warn load-error" role="alert">
          <span>Couldn’t load transactions: {messageOf(transactions.error)}</span>
          <button type="button" className="secondary" onClick={transactions.reload}>
            Try again
          </button>
        </div>
      )}

      <div className="table-wrap" aria-busy={transactions.loading}>
        <table className={editing ? 'register editing' : 'register'}>
          <thead>
            <tr>
              <th scope="col">Date</th>
              {showAccountColumn && <th scope="col">Account</th>}
              <th scope="col">Payee</th>
              <th scope="col">Category</th>
              <th scope="col" className="num">
                Outflow
              </th>
              <th scope="col" className="num">
                Inflow
              </th>
              <th scope="col" className="cleared-col" title="Cleared">
                <span className="sr-only">Cleared</span>
                <span aria-hidden>✓</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {editing === 'new' && (
              <TransactionRow
                key="new"
                transaction={null}
                transfer={null}
                accounts={scoped.filter((a) => !a.closed)}
                defaultAccountId={accountId ?? scoped.find((a) => !a.closed)?.id ?? ''}
                showAccountColumn={showAccountColumn}
                groups={groups.data ?? []}
                goals={goals.data ?? []}
                payees={payees}
                deposits={deposits}
                hasFund={hasFund}
                ask={ask}
                onDirtyChange={setDirty}
                onCancel={closeEditor}
                onSave={(input) =>
                  write(() =>
                    budget.createTransaction({
                      accountId: input.accountId,
                      date: input.date,
                      payee: input.payee,
                      splits: input.splits,
                      grossAmount: input.grossAmount,
                      reversesId: input.reversesId,
                      emergency: input.emergency,
                    }),
                  )
                }
              />
            )}
            {shown.slice(0, shownCount).map((t) =>
              editing === t.id ? (
                <TransactionRow
                  key={t.id}
                  transaction={t}
                  accounts={accounts}
                  defaultAccountId={t.accountId}
                  showAccountColumn={showAccountColumn}
                  groups={groups.data ?? []}
                  goals={goals.data ?? []}
                  payees={payees}
                  deposits={deposits}
                  hasFund={hasFund}
                  ask={ask}
                  onDirtyChange={setDirty}
                  onCancel={closeEditor}
                  transfer={transferInfo(t, names.account)}
                  onSave={async (input) => {
                    // A transfer has no payee or splits; its amount carries to the other leg.
                    const patch = t.transferPairId
                      ? {
                          date: input.date,
                          amount: input.splits[0]!.amount,
                          categoryId: input.splits[0]!.categoryId,
                          goalId: input.splits[0]!.goalId,
                        }
                      : {
                          date: input.date,
                          payee: input.payee || null,
                          splits: input.splits,
                          grossAmount: input.grossAmount,
                          reversesId: input.reversesId,
                          emergency: input.emergency,
                        }
                    await write(() => budget.updateTransaction(t.id, patch))
                    closeEditor()
                  }}
                  onDelete={async () => {
                    const ok = await ask(deleteQuestion(t, names.account))
                    if (!ok) return
                    await write(() => budget.deleteTransaction(t.id))
                    closeEditor()
                  }}
                />
              ) : (
                <TransactionLine
                  key={t.id}
                  t={t}
                  showAccountColumn={showAccountColumn}
                  names={names}
                  onOpen={() => void openEditor(t.id)}
                  onToggleCleared={() =>
                    void run(() => budget.updateTransaction(t.id, { cleared: !t.cleared }))
                  }
                />
              ),
            )}
          </tbody>
        </table>
        {!transactions.loading && shown.length === 0 && editing !== 'new' && (
          <p className="empty">
            {isFiltered(activeFilter)
              ? 'No transactions match these filters.'
              : 'No transactions yet.'}
          </p>
        )}
        {shown.length > shownCount && (
          <p className="register-more">
            <span className="muted">
              Showing {shownCount.toLocaleString()} of {shown.length.toLocaleString()}
            </span>{' '}
            <button
              type="button"
              onClick={() => setPaging({ scope, size: shownCount + PAGE_SIZE })}
            >
              Show more
            </button>
          </p>
        )}
      </div>

      {transferring && (
        <TransferDialog
          onClose={() => setTransferring(false)}
          accounts={openAccounts}
          defaultFromId={accountId}
        />
      )}
      {account && reconciling && (
        <ReconcileDialog onClose={() => setReconciling(false)} account={account} />
      )}
      {account && renaming && (
        <RenameAccountSheet account={account} onClose={() => setRenaming(false)} />
      )}
      {confirmDialog}
    </div>
  )
}

interface Names {
  category: Map<string, string>
  goal: Map<string, string>
  account: Map<string, Account>
}

function TransactionLine(props: {
  t: Transaction
  showAccountColumn: boolean
  names: Names
  onOpen: () => void
  onToggleCleared: () => void
}) {
  const { t, names } = props
  const category = categoryLabel(t, names.category, names.goal, names.account)
  const payee = payeeLabel(t, names.account)
  const state = t.reconciled ? 'Cleared and reconciled' : t.cleared ? 'Cleared' : 'Not cleared'
  return (
    // The whole row is a click target for the mouse; the payee button is what the keyboard and
    // screen readers use, and its click bubbles up here.
    <tr className="txn-row" data-txn={t.id} onClick={props.onOpen}>
      <td>{shortDate(t.date)}</td>
      {props.showAccountColumn && <td>{names.account.get(t.accountId)?.name ?? ''}</td>}
      <td>
        <button type="button" className="row-open">
          {payee || <span className="sr-only">Edit transaction</span>}
        </button>
        {t.emergency && (
          <>
            {' '}
            <span className="tag emergency" title="Paid for from the emergency fund">
              Emergency
            </span>
          </>
        )}
        {!t.approved && (
          <>
            {' '}
            <a
              className="tag"
              href="#/inbox"
              title="Imported from your bank and waiting for approval in the inbox"
              onClick={(e) => e.stopPropagation()}
            >
              Needs review
            </a>
          </>
        )}
      </td>
      <td className={category === 'Uncategorized' ? 'uncategorized' : undefined}>{category}</td>
      <td className="num">{t.amount < 0 ? money(-t.amount) : ''}</td>
      <td className="num">{t.amount > 0 ? money(t.amount) : ''}</td>
      <td className="cleared-col">
        <button
          type="button"
          className={
            t.reconciled ? 'clear-toggle on locked' : t.cleared ? 'clear-toggle on' : 'clear-toggle'
          }
          aria-pressed={t.cleared}
          aria-label={`${state}: ${t.payee ?? 'transaction'} on ${shortDate(t.date)}`}
          title={
            t.reconciled
              ? 'Reconciled, so it is locked'
              : t.cleared
                ? 'Cleared. Press to mark it not cleared.'
                : 'Not cleared. Press to mark it cleared.'
          }
          disabled={t.reconciled}
          onClick={(e) => {
            e.stopPropagation()
            props.onToggleCleared()
          }}
        >
          {t.reconciled ? '🔒' : t.cleared ? '✓' : ''}
        </button>
      </td>
    </tr>
  )
}

const payeeLabel = (t: Transaction, accounts: Map<string, Account>) =>
  t.transferPairId
    ? `Transfer: ${accounts.get(t.transferAccountId ?? '')?.name ?? 'removed account'}`
    : (t.payee ?? '')

/** What to ask before deleting; says what else goes with it. */
function deleteQuestion(t: Transaction, accounts: Map<string, Account>): ConfirmOptions {
  const other = t.transferPairId ? accounts.get(t.transferAccountId ?? '') : undefined
  return {
    title: 'Delete this transaction?',
    message: (
      <>
        <p>
          {payeeLabel(t, accounts) || 'No payee'}, {money(Math.abs(t.amount))} on{' '}
          {shortDate(t.date)}
        </p>
        {t.transferPairId && (
          <p>
            It is one side of a transfer, so the other side
            {other ? ` in ${other.name}` : ''} is deleted too.
          </p>
        )}
        {t.importId !== null && <p>It came from your bank. It won’t be imported again.</p>}
      </>
    ),
    confirmLabel: 'Delete transaction',
    danger: true,
  }
}

/** What the editor needs to know about a transfer leg; null for an ordinary transaction. */
function transferInfo(t: Transaction, accounts: Map<string, Account>) {
  if (!t.transferPairId) return null
  const mine = accounts.get(t.accountId)
  const other = accounts.get(t.transferAccountId ?? '')
  return {
    label: payeeLabel(t, accounts),
    // Only the budget side of a transfer to a tracking account takes a category.
    categoryEditable: !!mine?.onBudget && other !== undefined && !other.onBudget,
  }
}

function categoryLabel(
  t: Transaction,
  names: Map<string, string>,
  goalNames: Map<string, string>,
  accounts: Map<string, Account>,
): string {
  if (t.splits.length > 1) return `Split (${t.splits.length})`
  const account = accounts.get(t.accountId)
  const id = t.splits[0]?.categoryId
  if (id) {
    const name = names.get(id) ?? 'Unknown category'
    const goal = t.splits[0]?.goalId
    return goal ? `${name}: ${goalNames.get(goal) ?? 'Unknown goal'}` : name
  }
  if (!account?.onBudget) return ''
  if (t.transferPairId) {
    // Between two budget accounts nothing enters or leaves the budget.
    const other = accounts.get(t.transferAccountId ?? '')
    if (!other || other.onBudget) return ''
  }
  return t.amount > 0 ? 'Inflow: Ready to Assign' : 'Uncategorized'
}

function AccountMenu({
  account,
  transactionCount,
  run,
  ask,
  onRename,
}: {
  account: Account
  /** Null while they are loading. */
  transactionCount: number | null
  run: (fn: () => Promise<unknown>) => Promise<void>
  ask: (options: ConfirmOptions) => Promise<boolean>
  onRename: () => void
}) {
  // The core refuses an account with transactions, so say so here instead of failing afterwards.
  const used = transactionCount !== null && transactionCount > 0
  return (
    <Menu
      label={`Options for ${account.name}`}
      items={[
        { label: 'Rename', onSelect: onRename },
        {
          label: account.closed ? 'Reopen' : 'Close',
          onSelect: () =>
            void run(() => budget.updateAccount(account.id, { closed: !account.closed })),
        },
        {
          label: 'Delete',
          disabled: used,
          title: used ? 'It has transactions. Close the account instead.' : undefined,
          onSelect: () =>
            void (async () => {
              const ok = await ask({
                title: `Delete ${account.name}?`,
                message: <p>It has no transactions. This can’t be undone.</p>,
                confirmLabel: 'Delete account',
                danger: true,
              })
              if (!ok) return
              await run(async () => {
                await budget.deleteAccount(account.id)
                location.hash = '#/budget'
              })
            })(),
        },
      ]}
    />
  )
}
