import { cleanName, flag, type CrudDeps } from './crud.ts'
import type { SqlRunner } from './storage.ts'

export const ACCOUNT_TYPES = ['checking', 'credit', 'savings', 'investment'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export interface Account {
  id: string
  name: string
  type: AccountType
  /** Investment accounts are tracking accounts and are never on budget. */
  onBudget: boolean
  closed: boolean
}

export interface AccountsApi {
  listAccounts(): Promise<Account[]>
  createAccount(input: { name: string; type: AccountType; onBudget?: boolean }): Promise<Account>
  /** The type is fixed at creation: it decides how the account's balance is treated. */
  updateAccount(
    id: string,
    changes: { name?: string; onBudget?: boolean; closed?: boolean },
  ): Promise<Account>
  deleteAccount(id: string): Promise<void>
}

interface AccountRow {
  id: string
  name: string
  type: AccountType
  on_budget: number
  closed: number
}

const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  name: r.name,
  type: r.type,
  onBudget: r.on_budget === 1,
  closed: r.closed === 1,
})

const SELECT = 'SELECT id, name, type, on_budget, closed FROM accounts'

async function getAccount(db: SqlRunner, id: string): Promise<Account> {
  const [row] = await db.query<AccountRow & Record<string, never>>(`${SELECT} WHERE id = ?`, [id])
  if (!row) throw new Error('Account not found')
  return toAccount(row)
}

async function assertNameFree(db: SqlRunner, name: string, exceptId?: string) {
  const [dup] = await db.query(
    'SELECT 1 AS x FROM accounts WHERE name = ? COLLATE NOCASE AND id <> ?',
    [name, exceptId ?? ''],
  )
  if (dup) throw new Error(`An account named "${name}" already exists`)
}

function assertBudgetable(type: AccountType, onBudget: boolean) {
  if (type === 'investment' && onBudget) {
    throw new Error('Investment accounts are tracking accounts and cannot be on budget')
  }
}

export function accountsApi({ adapter, newId, now }: CrudDeps): AccountsApi {
  return {
    async listAccounts() {
      const rows = await adapter.query<AccountRow & Record<string, never>>(
        `${SELECT} ORDER BY created_at, rowid`,
      )
      return rows.map(toAccount)
    },
    async createAccount({ name, type, onBudget }) {
      const clean = cleanName(name, 'Account')
      if (!ACCOUNT_TYPES.includes(type)) throw new Error(`Unknown account type "${String(type)}"`)
      const budgeted = onBudget ?? type !== 'investment'
      assertBudgetable(type, budgeted)
      return adapter.transaction(async (tx) => {
        await assertNameFree(tx, clean)
        const id = newId()
        await tx.exec(
          'INSERT INTO accounts (id, name, type, on_budget, closed, created_at) VALUES (?, ?, ?, ?, 0, ?)',
          [id, clean, type, flag(budgeted), now()],
        )
        return getAccount(tx, id)
      })
    },
    async updateAccount(id, changes) {
      return adapter.transaction(async (tx) => {
        const current = await getAccount(tx, id)
        const name = changes.name === undefined ? current.name : cleanName(changes.name, 'Account')
        const onBudget = changes.onBudget ?? current.onBudget
        assertBudgetable(current.type, onBudget)
        if (name !== current.name) await assertNameFree(tx, name, id)
        await tx.exec('UPDATE accounts SET name = ?, on_budget = ?, closed = ? WHERE id = ?', [
          name,
          flag(onBudget),
          flag(changes.closed ?? current.closed),
          id,
        ])
        return getAccount(tx, id)
      })
    },
    async deleteAccount(id) {
      await adapter.transaction(async (tx) => {
        await getAccount(tx, id)
        await tx.exec('DELETE FROM accounts WHERE id = ?', [id])
      })
    },
  }
}
