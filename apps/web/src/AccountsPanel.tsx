import { ACCOUNT_TYPES, type Account, type AccountType } from '@budget-fi/core'
import { useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { messageOf } from './errors.ts'
import { useAsync } from './hooks.ts'

export function AccountsPanel() {
  const accounts = useAsync(() => budget.listAccounts())
  const [name, setName] = useState('')
  const [type, setType] = useState<AccountType>('checking')
  const [error, setError] = useState<string | null>(null)

  async function run(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      accounts.reload()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    await run(async () => {
      await budget.createAccount({ name, type })
      setName('')
    })
  }

  return (
    <section aria-labelledby="accounts-heading">
      <h2 id="accounts-heading">Accounts</h2>
      <ul className="items">
        {accounts.data?.map((a) => (
          <AccountItem key={a.id} account={a} run={run} />
        ))}
      </ul>
      {accounts.data?.length === 0 && <p className="muted">No accounts yet.</p>}
      <form onSubmit={(e) => void add(e)}>
        <label>
          Account name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Account type
          <select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            {ACCOUNT_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <button type="submit">Add account</button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  )
}

function AccountItem({
  account,
  run,
}: {
  account: Account
  run: (fn: () => Promise<unknown>) => Promise<void>
}) {
  return (
    <li className={account.closed ? 'closed' : undefined}>
      <span className="grow">
        {account.name}{' '}
        <small className="muted">
          {account.type}
          {account.onBudget ? '' : ' · tracking'}
          {account.closed ? ' · closed' : ''}
        </small>
      </span>
      <button
        className="secondary"
        onClick={() => {
          const name = prompt('Rename account', account.name)
          if (name !== null) void run(() => budget.updateAccount(account.id, { name }))
        }}
      >
        Rename
      </button>
      <button
        className="secondary"
        onClick={() =>
          void run(() => budget.updateAccount(account.id, { closed: !account.closed }))
        }
      >
        {account.closed ? 'Reopen' : 'Close'}
      </button>
      <button
        className="secondary"
        onClick={() => {
          if (confirm(`Delete ${account.name}?`)) void run(() => budget.deleteAccount(account.id))
        }}
      >
        Delete
      </button>
    </li>
  )
}
