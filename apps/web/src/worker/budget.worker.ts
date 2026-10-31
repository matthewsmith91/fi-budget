/// <reference lib="webworker" />
import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm'
import {
  createBudgetApi,
  httpSyncTransport,
  memoryBackend,
  migrate,
  seedDemoBudget,
  serve,
  SqliteAdapter,
  type Endpoint,
  type RpcMethods,
  type SqliteBackend,
} from '@budget-fi/core'
import { DEMO } from '../demo-mode.ts'
import { loadDeviceId } from './device-id.ts'
import { DatabaseLockedError } from './errors.ts'

const DB_PATH = '/budget.sqlite3'
const LOCK_NAME = 'budget-fi-database'

/**
 * The OPFS pool allows a single connection, so one tab owns the database at a time.
 * The lock is held for the life of this worker and released when the tab closes.
 */
function acquireDatabaseLock(): Promise<boolean> {
  if (!('locks' in navigator)) return Promise.resolve(true)
  return new Promise((resolve) => {
    void navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      resolve(lock !== null)
      return lock ? new Promise<never>(() => {}) : undefined
    })
  })
}

async function opfsBackend(sqlite3: Sqlite3Static): Promise<SqliteBackend> {
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'budget-fi', directory: '/budget-fi' })
  return {
    open: () => new pool.OpfsSAHPoolDb(DB_PATH),
    importFile: async (bytes) => {
      await pool.importDb(DB_PATH, bytes)
    },
  }
}

function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function start(): Promise<RpcMethods> {
  // Demo mode never opens the real database, so it needs neither its lock nor OPFS.
  if (!DEMO && !(await acquireDatabaseLock())) throw new DatabaseLockedError()
  const sqlite3 = await sqlite3InitModule()
  let storage: 'opfs' | 'memory' = 'opfs'
  let backend: SqliteBackend
  try {
    if (DEMO) throw new Error('demo mode keeps the budget in memory')
    backend = await opfsBackend(sqlite3)
  } catch (err) {
    // No OPFS (private browsing, old browser): run, but be loud that nothing persists.
    if (!DEMO) console.warn('OPFS unavailable, falling back to memory', err)
    storage = 'memory'
    backend = memoryBackend(sqlite3)
  }
  const adapter = await SqliteAdapter.open(sqlite3, backend)
  await migrate(adapter)
  const api = createBudgetApi({
    adapter,
    storage,
    deviceId: await loadDeviceId(),
    // No server in demo mode: sync and the bank proxy report themselves unavailable.
    syncTransport: DEMO ? undefined : httpSyncTransport(),
    sqliteVersion: sqlite3.version.libVersion,
  })
  if (DEMO) await seedDemoBudget(api, { today: localToday() })
  return api as unknown as RpcMethods
}

serve(start(), self as unknown as Endpoint)
