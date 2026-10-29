import type { ChangeLog } from './changes.ts'
import type { SqlRunner, StorageAdapter } from './storage.ts'

export interface CrudDeps {
  adapter: StorageAdapter
  newId: () => string
  now: () => string
  /** The change log for a transaction; all writes to synced tables go through it. */
  changes: (tx: SqlRunner) => ChangeLog
}

export function cleanName(input: string, what: string): string {
  const name = input.trim()
  if (!name) throw new Error(`${what} name is required`)
  return name
}

const DATE = /^\d{4}-\d\d-\d\d$/

export function assertDate(date: string): void {
  const valid = DATE.test(date) && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date)
  if (!valid) throw new Error(`"${date}" is not a date (expected YYYY-MM-DD)`)
}

export const flag = (b: boolean) => (b ? 1 : 0)

/** Ids to reorder must be exactly the ids currently in scope, each once. */
export function assertSameIds(given: readonly string[], existing: readonly string[], what: string) {
  const want = new Set(existing)
  if (
    given.length !== want.size ||
    new Set(given).size !== want.size ||
    !given.every((id) => want.has(id))
  ) {
    throw new Error(`Reorder must list every ${what} exactly once`)
  }
}

/** The payee on the adjustment a reconciliation posts, so income rules can leave it alone. */
export const ADJUSTMENT_PAYEE = 'Reconciliation Balance Adjustment'
