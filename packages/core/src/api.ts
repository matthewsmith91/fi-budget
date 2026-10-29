import { accountsApi, type AccountsApi } from './accounts.ts'
import { activityApi, type ActivityApi } from './activity.ts'
import { allocationsApi, type AllocationsApi } from './allocations.ts'
import { emergencyFundApi, type EmergencyFundApi } from './emergency-fund.ts'
import { exportJson, importJson, importSqlite } from './budget-file.ts'
import { changeLog } from './changes.ts'
import { categoriesApi, type CategoriesApi } from './categories.ts'
import { newDeviceId } from './hlc.ts'
import { goalsApi, type GoalsApi } from './goals.ts'
import { importsApi, type ImportsApi } from './imports.ts'
import { investmentsApi, type InvestmentsApi } from './investments.ts'
import { currentVersion } from './migrations.ts'
import { payeeRulesApi, type PayeeRulesApi } from './payee-rules.ts'
import { reconcileApi, type ReconcileApi } from './reconcile.ts'
import { reportsApi, type ReportsApi } from './reports.ts'
import type { SqlRunner, StorageAdapter } from './storage.ts'
import {
  createSyncEngine,
  SyncError,
  type SyncResult,
  type SyncSetup,
  type SyncStatus,
  type SyncTransport,
} from './sync.ts'
import { transactionsApi, type TransactionsApi } from './transactions.ts'
import { ynabApi, type YnabApi } from './ynab.ts'

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
export interface BudgetApi
  extends
    AccountsApi,
    CategoriesApi,
    AllocationsApi,
    GoalsApi,
    TransactionsApi,
    ReconcileApi,
    ActivityApi,
    ImportsApi,
    InvestmentsApi,
    PayeeRulesApi,
    ReportsApi,
    EmergencyFundApi,
    YnabApi {
  getStatus(): Promise<AppStatus>
  getHousehold(): Promise<Household | null>
  createHousehold(input: { name: string; members: string[] }): Promise<Household>
  exportJson(): Promise<string>
  exportSqlite(): Promise<Uint8Array>
  importJson(text: string): Promise<ImportResult>
  importSqlite(bytes: Uint8Array): Promise<ImportResult>
  /** Pushes local changes to the server and merges what the other devices sent. */
  syncNow(): Promise<SyncResult>
  getSyncStatus(): Promise<SyncStatus>
  /** What turning on sync here would do: upload this budget, download the household's, or clash. */
  getSyncSetup(): Promise<SyncSetup>
  /**
   * Replaces this device's budget with the server's full file and brings it up to date.
   * The returned image is this device's budget as it was, in case it should be kept.
   */
  downloadServerBudget(): Promise<ImportResult & { sync: SyncResult }>
}

export interface ApiDeps {
  adapter: StorageAdapter
  storage: AppStatus['storage']
  sqliteVersion: string
  /** This device's id, stamped on every change. Must be stable across restarts of one device. */
  deviceId?: string
  /** How to reach the sync server; without it `syncNow` reports that sync is unavailable. */
  syncTransport?: SyncTransport
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
      'SELECT id, display_name FROM members WHERE household_id = ? ORDER BY created_at, id',
      [h.id],
    )
    return {
      id: h.id,
      name: h.name,
      members: members.map((m) => ({ id: m.id, displayName: m.display_name })),
    }
  }

  const deviceId = deps.deviceId ?? newDeviceId()
  const crud = { adapter, newId, now, changes: (tx: SqlRunner) => changeLog(tx, { deviceId, now }) }

  const sync = deps.syncTransport
    ? createSyncEngine({ adapter, transport: deps.syncTransport, now })
    : null

  return {
    ...accountsApi(crud),
    ...categoriesApi(crud),
    ...allocationsApi(crud),
    ...goalsApi(crud),
    ...transactionsApi(crud),
    ...reconcileApi(crud),
    ...importsApi(crud),
    ...investmentsApi(crud),
    ...payeeRulesApi(crud),
    ...reportsApi(crud),
    ...emergencyFundApi(crud),
    ...ynabApi(crud),
    ...activityApi({ ...crud, deviceId, mode: sync ? 'sync' : 'local' }),
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
        const log = crud.changes(tx)
        await log.insert('households', { id: householdId, name: cleanName, created_at: at })
        for (const display of names) {
          await log.insert('members', {
            id: newId(),
            household_id: householdId,
            display_name: display,
            created_at: at,
          })
        }
      })
      return (await getHousehold())!
    },
    exportJson: () => exportJson(adapter, now),
    exportSqlite: () => adapter.exportFile(),
    async syncNow() {
      if (!sync) throw new SyncError('Sync is not available on this device')
      return sync.sync()
    },
    async getSyncStatus() {
      return sync ? sync.status() : { linked: false, pending: 0, lastSyncAt: null }
    },
    async getSyncSetup() {
      if (!sync) throw new SyncError('Sync is not available on this device')
      return sync.setup()
    },
    async downloadServerBudget() {
      if (!sync) throw new SyncError('Sync is not available on this device')
      const safetyBackup = await adapter.exportFile()
      await sync.downloadFile()
      return { safetyBackup, sync: await sync.sync() }
    },
    async importJson(text) {
      const safetyBackup = await adapter.exportFile()
      await importJson(adapter, text)
      sync?.reset()
      return { safetyBackup }
    },
    async importSqlite(bytes) {
      const safetyBackup = await adapter.exportFile()
      await importSqlite(adapter, bytes)
      sync?.reset()
      return { safetyBackup }
    },
  }
}
