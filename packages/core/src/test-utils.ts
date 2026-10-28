import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm'
import { migrate } from './migrations.ts'
import { memoryBackend, SqliteAdapter } from './sqlite-adapter.ts'

let sqlite3: Promise<Sqlite3Static> | undefined

export async function openMemoryAdapter(opts: { migrated?: boolean } = {}) {
  sqlite3 ??= sqlite3InitModule()
  const lib = await sqlite3
  const adapter = await SqliteAdapter.open(lib, memoryBackend(lib))
  if (opts.migrated !== false) await migrate(adapter)
  return adapter
}
