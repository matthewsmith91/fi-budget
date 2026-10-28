import { exportJson, importJson, importSqlite } from './budget-file.ts'
import { currentVersion } from './migrations.ts'
import type { StorageAdapter } from './storage.ts'

export interface Household {
  id: string
  name: string
  members: { id: string; displayName: string }[]
}

export interface AppStatus {
  schemaVersion: number
  sqliteVersion: string
  /** `opfs` is durable; `memory` means this browser could not persist the file. */
  storage: 'opfs' | 'memory'
}

export interface ImportResult {
  /** SQLite image of the budget as it was just before the import replaced it. */
  safetyBackup: Uint8Array
}

/** Everything the UI may ask of the domain layer. Grows each phase. */
export interface BudgetApi {
  getStatus(): Promise<AppStatus>
  getHousehold(): Promise<Household | null>
  createHousehold(input: { name: string; members: string[] }): Promise<Household>
  exportJson(): Promise<string>
  exportSqlite(): Promise<Uint8Array>
  importJson(text: string): Promise<ImportResult>
  importSqlite(bytes: Uint8Array): Promise<ImportResult>
}

export interface ApiDeps {
  adapter: StorageAdapter
  storage: AppStatus['storage']
  sqliteVersion: string
  newId?: () => string
  now?: () => string
}

export function createBudgetApi(deps: ApiDeps): BudgetApi {
  const { adapter } = deps
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const now = deps.now ?? (() => new Date().toISOString())

  async function getHousehold(): Promise<Household | null> {
    const [h] = await adapter.query<{ id: string; name: string }>(
      'SELECT id, name FROM households ORDER BY created_at, id LIMIT 1',
    )
    if (!h) return null
    const members = await adapter.query<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM members WHERE household_id = ? ORDER BY created_at, rowid',
      [h.id],
    )
    return {
      id: h.id,
      name: h.name,
      members: members.map((m) => ({ id: m.id, displayName: m.display_name })),
    }
  }

  return {
    async getStatus() {
      return {
        schemaVersion: await adapter.transaction((tx) => currentVersion(tx)),
        sqliteVersion: deps.sqliteVersion,
        storage: deps.storage,
      }
    },
    getHousehold,
    async createHousehold({ name, members }) {
      const cleanName = name.trim()
      const names = members.map((m) => m.trim()).filter(Boolean)
      if (!cleanName) throw new Error('Household name is required')
      if (names.length === 0) throw new Error('At least one member is required')
      await adapter.transaction(async (tx) => {
        const existing = await tx.query('SELECT 1 AS x FROM households LIMIT 1')
        if (existing.length > 0) throw new Error('This budget already has a household')
        const householdId = newId()
        const at = now()
        await tx.exec('INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)', [
          householdId,
          cleanName,
          at,
        ])
        for (const display of names) {
          await tx.exec(
            'INSERT INTO members (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)',
            [newId(), householdId, display, at],
          )
        }
      })
      return (await getHousehold())!
    },
    exportJson: () => exportJson(adapter, now),
    exportSqlite: () => adapter.exportFile(),
    async importJson(text) {
      const safetyBackup = await adapter.exportFile()
      await importJson(adapter, text)
      return { safetyBackup }
    },
    async importSqlite(bytes) {
      const safetyBackup = await adapter.exportFile()
      await importSqlite(adapter, bytes)
      return { safetyBackup }
    },
  }
}
