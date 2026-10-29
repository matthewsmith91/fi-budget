import {
  cents,
  formatCents,
  type Account,
  type AccountMapping,
  type ImportSummary,
} from '@budget-fi/core'
import { useState } from 'react'
import { bankApi, type BankLink, type ExternalAccount, type LinkFetch } from './bank.ts'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { useAsync } from './hooks.ts'

const WINDOWS = [30, 60, 90]

/**
 * Connecting a bank through SimpleFIN, choosing which app account each bank account feeds,
 * and pulling its transactions into the inbox. The server keeps the credential; this only
 * links, checks and fetches.
 */
export function BankPanel() {
  const refresh = useRefresh()
  const links = useAsync(() => bankApi.links())
  const accounts = useBudgetQuery(() => budget.listAccounts())
  const mappings = useBudgetQuery(() => budget.listAccountMappings())
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checks, setChecks] = useState<Record<string, LinkFetch>>({})
  const [imports, setImports] = useState<Record<string, ImportSummary>>({})
  const [days, setDays] = useState(30)

  async function run(fn: () => Promise<void>) {
    setError(null)
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const link = () =>
    run(async () => {
      await bankApi.link(token.trim())
      setToken('')
      links.reload()
    })

  const unlink = (id: string) =>
    run(async () => {
      await bankApi.unlink(id)
      setChecks(({ [id]: _gone, ...rest }) => rest)
      links.reload()
    })

  const check = (id: string) =>
    run(async () => {
      const result = await bankApi.checkBalances(id)
      setChecks((all) => ({ ...all, [id]: result }))
      links.reload()
    })

  const map = (external: ExternalAccount | AccountMapping, accountId: string | null) =>
    run(async () => {
      const externalId = 'externalId' in external ? external.externalId : external.id
      await budget.mapExternalAccount({
        externalId,
        name: external.name,
        org: 'org' in external ? external.org : undefined,
        accountId,
      })
      refresh()
    })

  const importFrom = (id: string) =>
    run(async () => {
      const result = await bankApi.fetchTransactions(id, days)
      setChecks((all) => ({ ...all, [id]: result }))
      links.reload()
      if (!result.ok) return
      const summary = await budget.importTransactions(result.accounts)
      setImports((all) => ({ ...all, [id]: summary }))
      refresh()
    })

  return (
    <section className="card stack">
      <h2>Bank connections</h2>
      <p className="muted">
        Connect your bank through SimpleFIN Bridge. The server holds the connection and neither
        device ever sees the bank login. Create a setup token in your SimpleFIN account and paste it
        here; it works once.
      </p>
      {links.loading && <p className="muted">Checking the server…</p>}
      {links.data?.length === 0 && <p className="muted">No bank is connected yet.</p>}
      {links.data?.map((l) => (
        <LinkRow
          key={l.id}
          link={l}
          check={checks[l.id]}
          summary={imports[l.id]}
          accounts={(accounts.data ?? []).filter((a) => !a.closed)}
          mappings={mappings.data ?? []}
          days={days}
          busy={busy}
          onDays={setDays}
          onCheck={() => void check(l.id)}
          onImport={() => void importFrom(l.id)}
          onMap={(external, accountId) => void map(external, accountId)}
          onUnlink={() => void unlink(l.id)}
        />
      ))}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void link()
        }}
      >
        <label>
          SimpleFIN setup token
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="row">
          <button type="submit" disabled={busy || !token.trim()}>
            Connect bank
          </button>
        </div>
      </form>
      {(error ?? links.error) && (
        <p className="error" role="alert">
          {error ?? links.error?.message}
        </p>
      )}
    </section>
  )
}

function LinkRow(props: {
  link: BankLink
  check: LinkFetch | undefined
  summary: ImportSummary | undefined
  accounts: Account[]
  mappings: AccountMapping[]
  days: number
  busy: boolean
  onDays: (days: number) => void
  onCheck: () => void
  onImport: () => void
  onMap: (external: ExternalAccount | AccountMapping, accountId: string | null) => void
  onUnlink: () => void
}) {
  const { link, check } = props
  const fetched = check?.ok ? check.accounts : []
  // Bank accounts seen on this fetch, then any mapped earlier that this fetch did not return.
  const seen = new Set(fetched.map((a) => a.id))
  const remembered = props.mappings.filter((m) => !seen.has(m.externalId))
  const mapped = new Map(props.mappings.map((m) => [m.externalId, m.accountId]))
  const anyMapped = props.mappings.some((m) => m.accountId !== null)
  return (
    <div className="stack">
      <div className="row">
        <span>
          SimpleFIN, connected {new Date(link.createdAt).toLocaleDateString()}
          {link.lastFetchedAt && (
            <>, last checked {new Date(link.lastFetchedAt).toLocaleString()}</>
          )}
          {link.queued > 0 && <>, {link.queued} new waiting to be brought in</>}
        </span>
        <button className="secondary" disabled={props.busy} onClick={props.onCheck}>
          Check balances
        </button>
        <button className="secondary danger" disabled={props.busy} onClick={props.onUnlink}>
          Disconnect
        </button>
      </div>
      {link.pullError && (
        <p className="error" role="alert">
          The daily check failed: {link.pullError}
        </p>
      )}
      {check && !check.ok && (
        <p className="error" role="alert">
          {check.error}
        </p>
      )}
      {(fetched.length > 0 || remembered.length > 0) && (
        <>
          <p className="muted">
            Choose the account each bank account feeds. Bank accounts left on “Don’t import” are
            skipped.
          </p>
          <dl>
            {fetched.map((a) => (
              <MappingRow
                key={a.id}
                label={a.org ? `${a.org} · ${a.name}` : a.name}
                balance={a.balance}
                value={mapped.get(a.id) ?? null}
                accounts={props.accounts}
                taken={props.mappings}
                externalId={a.id}
                disabled={props.busy}
                onChange={(accountId) => props.onMap(a, accountId)}
              />
            ))}
            {remembered.map((m) => (
              <MappingRow
                key={m.externalId}
                label={m.org ? `${m.org} · ${m.name}` : m.name}
                value={m.accountId}
                accounts={props.accounts}
                taken={props.mappings}
                externalId={m.externalId}
                disabled={props.busy}
                onChange={(accountId) => props.onMap(m, accountId)}
              />
            ))}
          </dl>
        </>
      )}
      {check?.ok && fetched.length === 0 && (
        <p className="muted">SimpleFIN reported no accounts.</p>
      )}
      {check?.ok &&
        check.messages.map((m) => (
          <p key={m} className="muted">
            {m}
          </p>
        ))}
      <div className="row">
        <label>
          Fetch the last{' '}
          <select value={props.days} onChange={(e) => props.onDays(Number(e.target.value))}>
            {WINDOWS.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <button disabled={props.busy || !anyMapped} onClick={props.onImport}>
          Import transactions
        </button>
        {!anyMapped && <span className="muted">Check balances and link an account first.</span>}
      </div>
      {props.summary && <ImportResult summary={props.summary} />}
    </div>
  )
}

function MappingRow(props: {
  label: string
  balance?: number
  value: string | null
  accounts: Account[]
  taken: AccountMapping[]
  externalId: string
  disabled: boolean
  onChange: (accountId: string | null) => void
}) {
  const usedElsewhere = new Set(
    props.taken.flatMap((m) =>
      m.externalId !== props.externalId && m.accountId ? [m.accountId] : [],
    ),
  )
  return (
    <>
      <dt>
        {props.label}
        {props.balance !== undefined && <> · {formatCents(cents(props.balance))}</>}
      </dt>
      <dd>
        <select
          aria-label={`Import ${props.label} into`}
          value={props.value ?? ''}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value || null)}
        >
          <option value="">Don’t import</option>
          {props.accounts.map((a) => (
            <option key={a.id} value={a.id} disabled={usedElsewhere.has(a.id)}>
              {a.name}
            </option>
          ))}
        </select>
      </dd>
    </>
  )
}

function ImportResult({ summary }: { summary: ImportSummary }) {
  const parts = [
    `${summary.added} new in the inbox`,
    summary.matched > 0 && `${summary.matched} matched to transactions you had entered`,
    summary.alreadyImported > 0 && `${summary.alreadyImported} already imported`,
    summary.dismissed > 0 && `${summary.dismissed} you removed earlier, left out`,
  ].filter(Boolean)
  return (
    <div role="status">
      <p>
        {parts.join(' · ')}. {summary.added > 0 && <a href="#/inbox">Review the inbox</a>}
      </p>
      {summary.unmapped.map((u) => (
        <p key={u.externalId} className="muted">
          {u.transactions} transaction{u.transactions === 1 ? '' : 's'} from “{u.name}” skipped: no
          account is linked.
        </p>
      ))}
    </div>
  )
}
