import {
  applyMigrations,
  currentVersion,
  LATEST_SCHEMA_VERSION,
  SchemaTooNewError,
} from './migrations.ts'
import { looksLikeSqlite } from './sqlite-adapter.ts'
import type { Row, SqlRunner, SqlValue, StorageAdapter } from './storage.ts'

export const EXPORT_FORMAT = 'budget-fi-export'
export const EXPORT_FORMAT_VERSION = 1

export interface BudgetExport {
  format: typeof EXPORT_FORMAT
  formatVersion: number
  schemaVersion: number
  exportedAt: string
  tables: Record<string, Row[]>
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

async function userTables(db: SqlRunner): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  )
  return rows.map((r) => r.name)
}

const quote = (ident: string) => `"${ident.replaceAll('"', '""')}"`

function encode(value: SqlValue): unknown {
  return value instanceof Uint8Array ? { $base64: toBase64(value) } : value
}

function decode(value: unknown): SqlValue {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'object' && value !== null && '$base64' in value) {
    const b64 = (value as { $base64: unknown }).$base64
    if (typeof b64 === 'string') return fromBase64(b64)
  }
  throw new ImportError(`Unsupported value in import: ${JSON.stringify(value)}`)
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export async function exportJson(
  adapter: StorageAdapter,
  now: () => string = () => new Date().toISOString(),
): Promise<string> {
  // one transaction so every table is read from the same snapshot
  const data = await adapter.transaction(async (tx) => {
    const tables: Record<string, Row[]> = {}
    for (const name of await userTables(tx)) {
      const rows = await tx.query(`SELECT * FROM ${quote(name)} ORDER BY rowid`)
      tables[name] = rows.map((r) =>
        Object.fromEntries(Object.entries(r).map(([k, v]) => [k, encode(v)])),
      ) as Row[]
    }
    return { schemaVersion: await currentVersion(tx), tables }
  })
  const out: BudgetExport = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    schemaVersion: data.schemaVersion,
    exportedAt: now(),
    tables: data.tables,
  }
  return JSON.stringify(out, null, 2)
}

function parseExport(text: string): BudgetExport {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ImportError('File is not valid JSON')
  }
  const o = raw as Partial<BudgetExport> | null
  if (!o || o.format !== EXPORT_FORMAT) throw new ImportError('Not a Budget-Fi export')
  if (o.formatVersion !== EXPORT_FORMAT_VERSION) {
    throw new ImportError(`Unsupported export format version ${String(o.formatVersion)}`)
  }
  if (!Number.isInteger(o.schemaVersion) || (o.schemaVersion as number) < 1) {
    throw new ImportError('Export is missing a schema version')
  }
  if (!o.tables || typeof o.tables !== 'object') throw new ImportError('Export has no tables')
  return o as BudgetExport
}

/**
 * Replaces the budget with a JSON export. The file's own schema version is rebuilt
 * first, rows are loaded, then newer migrations run, so an old export imports cleanly.
 * Everything happens in one transaction: a bad file leaves the current budget untouched.
 */
export async function importJson(adapter: StorageAdapter, text: string): Promise<void> {
  const file = parseExport(text)
  if (file.schemaVersion > LATEST_SCHEMA_VERSION) {
    throw new SchemaTooNewError(file.schemaVersion, LATEST_SCHEMA_VERSION)
  }
  await adapter.transaction(
    async (tx) => {
      for (const name of await userTables(tx)) await tx.exec(`DROP TABLE ${quote(name)}`)
      await applyMigrations(tx, { target: file.schemaVersion })
      const known = new Set(await userTables(tx))
      for (const [table, rows] of Object.entries(file.tables)) {
        if (table === 'schema_version') {
          // keep the file's own history; applyMigrations stamped fresh timestamps
          for (const r of rows as Row[]) {
            const version = r.version
            const appliedAt = r.applied_at
            if (
              !Number.isInteger(version) ||
              (version as number) > file.schemaVersion ||
              typeof appliedAt !== 'string'
            ) {
              throw new ImportError('Export has an invalid schema_version row')
            }
            await tx.exec('UPDATE schema_version SET applied_at = ? WHERE version = ?', [
              appliedAt,
              version as number,
            ])
          }
          continue
        }
        if (!known.has(table)) throw new ImportError(`Export has unknown table "${table}"`)
        if (!Array.isArray(rows)) throw new ImportError(`Table "${table}" is not a list of rows`)
        const columns = new Set(
          (await tx.query<{ name: string }>(`PRAGMA table_info(${quote(table)})`)).map(
            (c) => c.name,
          ),
        )
        for (const row of rows) {
          const keys = Object.keys(row)
          for (const k of keys) {
            if (!columns.has(k)) throw new ImportError(`Table "${table}" has unknown column "${k}"`)
          }
          if (keys.length === 0) continue
          await tx.exec(
            `INSERT INTO ${quote(table)} (${keys.map(quote).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
            keys.map((k) => decode(row[k])),
          )
        }
      }
      await applyMigrations(tx)
    },
    { foreignKeys: false },
  )
}

/**
 * Replaces the budget with a SQLite image. The image is swapped in, checked, and
 * the previous file is restored if the check fails.
 */
export async function importSqlite(adapter: StorageAdapter, bytes: Uint8Array): Promise<void> {
  if (!looksLikeSqlite(bytes)) throw new ImportError('Not a SQLite database file')
  const previous = await adapter.exportFile()
  try {
    await adapter.importFile(bytes)
    const [check] = await adapter.query<{ integrity_check: string }>('PRAGMA integrity_check')
    if (check?.integrity_check !== 'ok') throw new ImportError('Database file is corrupt')
    const tables = await adapter.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`,
    )
    if (tables.length === 0) throw new ImportError('Not a Budget-Fi database (no schema_version)')
    const version = await adapter.transaction((tx) => currentVersion(tx))
    if (version > LATEST_SCHEMA_VERSION) throw new SchemaTooNewError(version, LATEST_SCHEMA_VERSION)
    await adapter.transaction((tx) => applyMigrations(tx))
  } catch (err) {
    await adapter.importFile(previous)
    throw err
  }
}
