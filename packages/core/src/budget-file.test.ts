import { describe, expect, it } from 'vitest'
import { exportJson, importJson, importSqlite, ImportError } from './budget-file.ts'
import { MIGRATIONS, migrate, currentVersion, SchemaTooNewError } from './migrations.ts'
import { openMemoryAdapter } from './test-utils.ts'
import type { StorageAdapter } from './storage.ts'

async function seed(db: StorageAdapter) {
  await db.exec(`INSERT INTO households (id, name, created_at) VALUES ('h1', 'Smith', 't0')`)
  await db.exec(
    `INSERT INTO members (id, household_id, display_name, created_at) VALUES ('m1', 'h1', 'Matt', 't0')`,
  )
  await db.exec(
    `INSERT INTO members (id, household_id, display_name, created_at) VALUES ('m2', 'h1', 'Jessica', 't0')`,
  )
}

const snapshot = async (db: StorageAdapter) =>
  JSON.parse(await exportJson(db, () => 'fixed')) as Record<string, unknown>

describe('JSON export/import', () => {
  it('round-trips into an empty budget', async () => {
    const a = await openMemoryAdapter()
    await seed(a)
    const json = await exportJson(a)
    const b = await openMemoryAdapter()
    await importJson(b, json)
    expect(await snapshot(b)).toEqual(await snapshot(a))
  })

  it('replaces existing data rather than merging', async () => {
    const a = await openMemoryAdapter()
    await seed(a)
    const json = await exportJson(a)
    const b = await openMemoryAdapter()
    await b.exec(`INSERT INTO households (id, name, created_at) VALUES ('other', 'Other', 't1')`)
    await importJson(b, json)
    expect(await b.query('SELECT id FROM households')).toEqual([{ id: 'h1' }])
  })

  it('imports an older-schema export and migrates it forward', async () => {
    const a = await openMemoryAdapter()
    await seed(a)
    const parsed = JSON.parse(await exportJson(a))
    expect(parsed.schemaVersion).toBe(MIGRATIONS.length)
    const b = await openMemoryAdapter()
    await importJson(b, JSON.stringify(parsed))
    expect(await currentVersion(b)).toBe(MIGRATIONS.length)
  })

  it('is atomic: a bad file leaves the current budget untouched', async () => {
    const db = await openMemoryAdapter()
    await seed(db)
    const before = await snapshot(db)
    const bad = JSON.stringify({
      format: 'budget-fi-export',
      formatVersion: 1,
      schemaVersion: 1,
      exportedAt: 'x',
      tables: { households: [{ id: 'h9', name: 'X', created_at: 't' }], nope: [] },
    })
    await expect(importJson(db, bad)).rejects.toBeInstanceOf(ImportError)
    expect(await snapshot(db)).toEqual(before)
  })

  it('rejects rows that break foreign keys', async () => {
    const db = await openMemoryAdapter()
    await seed(db)
    const before = await snapshot(db)
    const bad = JSON.stringify({
      format: 'budget-fi-export',
      formatVersion: 1,
      schemaVersion: 1,
      exportedAt: 'x',
      tables: {
        members: [{ id: 'm', household_id: 'missing', display_name: 'X', created_at: 't' }],
      },
    })
    await expect(importJson(db, bad)).rejects.toThrow(/Foreign key/)
    expect(await snapshot(db)).toEqual(before)
  })

  it.each([
    ['not json', /not valid JSON/],
    [JSON.stringify({ format: 'other' }), /Not a Budget-Fi export/],
    [
      JSON.stringify({ format: 'budget-fi-export', formatVersion: 99 }),
      /Unsupported export format/,
    ],
  ])('rejects %s', async (text, pattern) => {
    const db = await openMemoryAdapter()
    await expect(importJson(db, text)).rejects.toThrow(pattern)
  })

  it('rejects exports from a newer app', async () => {
    const db = await openMemoryAdapter()
    const future = JSON.stringify({
      format: 'budget-fi-export',
      formatVersion: 1,
      schemaVersion: 999,
      exportedAt: 'x',
      tables: {},
    })
    await expect(importJson(db, future)).rejects.toBeInstanceOf(SchemaTooNewError)
  })

  it('preserves integer cents exactly', async () => {
    const db = await openMemoryAdapter()
    await db.exec(`CREATE TABLE amounts (id TEXT PRIMARY KEY, cents INTEGER NOT NULL)`)
    await db.exec(`INSERT INTO amounts VALUES ('a', 9007199254740991), ('b', -1)`)
    const json = await exportJson(db)
    expect(JSON.parse(json).tables.amounts).toEqual([
      { id: 'a', cents: 9007199254740991 },
      { id: 'b', cents: -1 },
    ])
  })
})

describe('SQLite export/import', () => {
  it('round-trips the file', async () => {
    const a = await openMemoryAdapter()
    await seed(a)
    const image = await a.exportFile()
    const b = await openMemoryAdapter()
    await importSqlite(b, image)
    expect(await snapshot(b)).toEqual(await snapshot(a))
  })

  it('restores the previous budget when the file is rejected', async () => {
    const db = await openMemoryAdapter()
    await seed(db)
    const before = await snapshot(db)
    // a valid SQLite file that is not a Budget-Fi database
    const other = await openMemoryAdapter({ migrated: false })
    await other.exec('CREATE TABLE junk (x)')
    await expect(importSqlite(db, await other.exportFile())).rejects.toThrow(/Not a Budget-Fi/)
    expect(await snapshot(db)).toEqual(before)
    await db.exec(`INSERT INTO households (id, name, created_at) VALUES ('h2', 'Still works', 't')`)
  })

  it('rejects files that are not SQLite', async () => {
    const db = await openMemoryAdapter()
    await expect(importSqlite(db, new Uint8Array(200))).rejects.toThrow(/Not a SQLite/)
  })

  it('rejects images from a newer schema and keeps the current budget', async () => {
    const db = await openMemoryAdapter()
    await seed(db)
    const before = await snapshot(db)
    const future = await openMemoryAdapter()
    await future.exec(`INSERT INTO schema_version VALUES (999, 'x')`)
    await expect(importSqlite(db, await future.exportFile())).rejects.toBeInstanceOf(
      SchemaTooNewError,
    )
    expect(await snapshot(db)).toEqual(before)
  })

  it('migrates an older image forward', async () => {
    const old = await openMemoryAdapter({ migrated: false })
    await migrate(old, { migrations: [MIGRATIONS[0]!] })
    const db = await openMemoryAdapter()
    await importSqlite(db, await old.exportFile())
    expect(await currentVersion(db)).toBe(MIGRATIONS.length)
  })
})
