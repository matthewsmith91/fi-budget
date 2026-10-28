import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm'
import type { Row, SqlRunner, SqlValue, StorageAdapter } from './storage.ts'

/** Where a SqliteAdapter's database lives (memory, OPFS, native file). */
export interface SqliteBackend {
  open(): Database | Promise<Database>
  /** Called with the current database closed; the next `open()` must return the imported file. */
  importFile(bytes: Uint8Array): void | Promise<void>
}

const SQLITE_MAGIC = 'SQLite format 3\0'

export function looksLikeSqlite(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false
  }
  return true
}

export class SqliteAdapter implements StorageAdapter {
  private chain: Promise<unknown> = Promise.resolve()

  private readonly sqlite3: Sqlite3Static
  private readonly backend: SqliteBackend
  private db: Database

  private constructor(sqlite3: Sqlite3Static, backend: SqliteBackend, db: Database) {
    this.sqlite3 = sqlite3
    this.backend = backend
    this.db = db
  }

  static async open(sqlite3: Sqlite3Static, backend: SqliteBackend): Promise<SqliteAdapter> {
    const db = await backend.open()
    db.exec('PRAGMA foreign_keys = ON')
    return new SqliteAdapter(sqlite3, backend, db)
  }

  private serialize<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => {})
    return next
  }

  private runner(): SqlRunner {
    const db = () => this.db
    return {
      exec: async (sql, params) => {
        db().exec({ sql, bind: params ? ([...params] as SqlValue[]) : undefined })
      },
      query: async <T extends Row>(sql: string, params?: readonly SqlValue[]) => {
        const rows = db().selectObjects(sql, params ? ([...params] as SqlValue[]) : undefined)
        return rows.map((r) => ({ ...r })) as T[]
      },
    }
  }

  exec(sql: string, params?: readonly SqlValue[]): Promise<void> {
    return this.serialize(() => this.runner().exec(sql, params))
  }

  query<T extends Row = Row>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
    return this.serialize(() => this.runner().query<T>(sql, params))
  }

  transaction<T>(
    fn: (tx: SqlRunner) => Promise<T>,
    opts: { foreignKeys?: boolean } = {},
  ): Promise<T> {
    return this.serialize(async () => {
      const fks = opts.foreignKeys !== false
      // PRAGMA foreign_keys is a no-op inside a transaction, so toggle it outside.
      if (!fks) this.db.exec('PRAGMA foreign_keys = OFF')
      try {
        this.db.exec('BEGIN IMMEDIATE')
        try {
          const result = await fn(this.runner())
          if (!fks) {
            const bad = this.db.selectObjects('PRAGMA foreign_key_check')
            if (bad.length > 0) throw new Error(`Foreign key violations: ${JSON.stringify(bad)}`)
          }
          this.db.exec('COMMIT')
          return result
        } catch (err) {
          this.db.exec('ROLLBACK')
          throw err
        }
      } finally {
        if (!fks) this.db.exec('PRAGMA foreign_keys = ON')
      }
    })
  }

  exportFile(): Promise<Uint8Array> {
    return this.serialize(() => this.sqlite3.capi.sqlite3_js_db_export(this.db))
  }

  importFile(bytes: Uint8Array): Promise<void> {
    return this.serialize(async () => {
      if (!looksLikeSqlite(bytes)) throw new Error('Not a SQLite database file')
      this.db.close()
      await this.backend.importFile(bytes)
      this.db = await this.backend.open()
      this.db.exec('PRAGMA foreign_keys = ON')
    })
  }

  close(): Promise<void> {
    return this.serialize(() => this.db.close())
  }
}

/** A throwaway in-memory database; used by tests and as the no-OPFS fallback. */
export function memoryBackend(sqlite3: Sqlite3Static): SqliteBackend {
  let pending: Uint8Array | null = null
  return {
    open() {
      const db = new sqlite3.oo1.DB(':memory:')
      if (pending) {
        const p = sqlite3.wasm.allocFromTypedArray(pending)
        const flags =
          sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
        const rc = sqlite3.capi.sqlite3_deserialize(
          db.pointer!,
          'main',
          p,
          pending.length,
          pending.length,
          flags,
        )
        pending = null
        db.checkRc(rc)
      }
      return db
    },
    importFile(bytes) {
      pending = bytes
    },
  }
}
