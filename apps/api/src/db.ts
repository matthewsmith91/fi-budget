import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Append-only, like the device-side migrations: never edit a released entry, add a new one.
 * Bank-sync tables arrive with their own migrations.
 */
export const MIGRATIONS: readonly string[] = [
  // 1: sign-in. Users and their passkeys, browser sessions, and one-time pairing codes.
  `CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE INDEX passkeys_user ON passkeys(user_id);
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE invites (
    code_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'device')),
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    created_by TEXT REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );`,
  // 2: the relayed change log. `seq` is arrival order, which is what a device's cursor
  // counts; `timestamp` is the HLC and is unique, so a re-pushed message is stored once.
  // The payload is opaque to the server (table, row, column, value) so it can be
  // encrypted later without a schema change.
  `CREATE TABLE server_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL
  );
  CREATE INDEX server_messages_timestamp ON server_messages(timestamp);`,
  // 3: the latest full budget file (a SQLite image uploaded by a device), for setting up a
  // new device without replaying the whole log. One row; `cursor` is the log position the
  // image already contains, so the new device pulls from there.
  `CREATE TABLE budget_file (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cursor INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );`,
]

export const DB_FILE = 'budget-fi.sqlite'

/** Opens (creating if needed) the server database and brings it to the latest schema. */
export function openDatabase(
  location: string,
  migrations: readonly string[] = MIGRATIONS,
): DatabaseSync {
  if (location !== ':memory:') mkdirSync(join(location, '..'), { recursive: true })
  const db = new DatabaseSync(location)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)',
  )
  migrate(db, migrations)
  return db
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null
  }
  return row.v ?? 0
}

function migrate(db: DatabaseSync, migrations: readonly string[]) {
  const current = schemaVersion(db)
  if (current > migrations.length) {
    throw new Error(
      `Database is at schema version ${current} but this server only knows ${migrations.length}; refusing to open a file from a newer version`,
    )
  }
  for (let version = current + 1; version <= migrations.length; version++) {
    db.exec('BEGIN')
    try {
      db.exec(migrations[version - 1]!)
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        version,
        new Date().toISOString(),
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`Migration ${version} failed`, { cause: error })
    }
  }
}
