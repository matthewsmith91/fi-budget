import type { SqlRunner, StorageAdapter } from './storage.ts'

export interface Migration {
  version: number
  name: string
  up: readonly string[]
}

/** Append-only: a released migration must never be edited. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'identity',
    up: [
      `CREATE TABLE households (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        encryption_key_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE members (
        id TEXT PRIMARY KEY,
        household_id TEXT NOT NULL REFERENCES households(id),
        display_name TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        member_id TEXT REFERENCES members(id),
        name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('local', 'sync')),
        last_sync_at TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    name: 'accounts-and-categories',
    // No UNIQUE on names: two devices may add the same name offline, and sync must
    // be able to merge both rows. The API rejects duplicates it can see.
    up: [
      `CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('checking', 'credit', 'savings', 'investment')),
        on_budget INTEGER NOT NULL CHECK (on_budget IN (0, 1)),
        closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
        created_by TEXT,
        created_at TEXT NOT NULL,
        CHECK (type <> 'investment' OR on_budget = 0)
      )`,
      `CREATE TABLE category_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sort INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE categories (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES category_groups(id),
        name TEXT NOT NULL,
        need_or_want TEXT NOT NULL DEFAULT 'want' CHECK (need_or_want IN ('need', 'want')),
        sort INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
        created_by TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX categories_group ON categories(group_id, sort)`,
    ],
  },
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version

export class SchemaTooNewError extends Error {
  readonly found: number
  readonly supported: number

  constructor(found: number, supported: number) {
    super(
      `This budget file is schema version ${found}, but this app only understands up to ${supported}. Update the app and try again.`,
    )
    this.found = found
    this.supported = supported
    this.name = 'SchemaTooNewError'
  }
}

const CREATE_SCHEMA_VERSION = `CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
)`

export async function currentVersion(db: SqlRunner): Promise<number> {
  await db.exec(CREATE_SCHEMA_VERSION)
  const [row] = await db.query<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_version')
  return row?.v ?? 0
}

/** Applies pending migrations inside whatever transaction the caller holds. */
export async function applyMigrations(
  db: SqlRunner,
  opts: { target?: number; now?: () => string; migrations?: readonly Migration[] } = {},
): Promise<number[]> {
  const migrations = opts.migrations ?? MIGRATIONS
  const latest = migrations[migrations.length - 1]!.version
  const target = opts.target ?? latest
  const now = opts.now ?? (() => new Date().toISOString())
  const from = await currentVersion(db)
  if (from > latest) throw new SchemaTooNewError(from, latest)
  const applied: number[] = []
  for (const m of migrations) {
    if (m.version <= from || m.version > target) continue
    for (const stmt of m.up) await db.exec(stmt)
    await db.exec('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', [
      m.version,
      now(),
    ])
    applied.push(m.version)
  }
  return applied
}

/** Brings a device's file to the latest schema, one atomic step per migration. */
export async function migrate(
  adapter: StorageAdapter,
  opts: { now?: () => string; migrations?: readonly Migration[] } = {},
): Promise<number[]> {
  const migrations = opts.migrations ?? MIGRATIONS
  const latest = migrations[migrations.length - 1]!.version
  const from = await adapter.transaction((tx) => currentVersion(tx))
  if (from > latest) throw new SchemaTooNewError(from, latest)
  const applied: number[] = []
  for (const m of migrations) {
    if (m.version <= from) continue
    await adapter.transaction(async (tx) => {
      applied.push(...(await applyMigrations(tx, { target: m.version, ...opts })))
    })
  }
  return applied
}
