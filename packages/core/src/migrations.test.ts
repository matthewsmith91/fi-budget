import { describe, expect, it } from 'vitest'
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  migrate,
  SchemaTooNewError,
  currentVersion,
} from './migrations.ts'
import { openMemoryAdapter } from './test-utils.ts'

const v1 = MIGRATIONS[0]!
const v2 = {
  version: 2,
  name: 'test-add-column',
  up: ['ALTER TABLE households ADD COLUMN currency TEXT'],
}

describe('migrations', () => {
  it('versions are contiguous and start at 1', () => {
    MIGRATIONS.forEach((m, i) => expect(m.version).toBe(i + 1))
  })

  it('migrates a fresh file to the latest version and records it', async () => {
    const db = await openMemoryAdapter({ migrated: false })
    const applied = await migrate(db, { now: () => '2026-01-01T00:00:00.000Z' })
    expect(applied).toEqual(MIGRATIONS.map((m) => m.version))
    expect(await db.query('SELECT version, applied_at FROM schema_version')).toEqual(
      MIGRATIONS.map((m) => ({ version: m.version, applied_at: '2026-01-01T00:00:00.000Z' })),
    )
  })

  it('is idempotent', async () => {
    const db = await openMemoryAdapter()
    expect(await migrate(db)).toEqual([])
  })

  it('opens a v1 file under newer code and migrates it forward without losing data', async () => {
    const db = await openMemoryAdapter({ migrated: false })
    await migrate(db, { migrations: [v1] })
    await db.exec(`INSERT INTO households (id, name, created_at) VALUES ('h1', 'Smith', 'now')`)
    const image = await db.exportFile()

    const next = await openMemoryAdapter({ migrated: false })
    await next.importFile(image)
    expect(await migrate(next, { migrations: [v1, v2] })).toEqual([2])
    expect(await next.query('SELECT id, name, currency FROM households')).toEqual([
      { id: 'h1', name: 'Smith', currency: null },
    ])
  })

  it('refuses a file from a newer app and leaves it untouched', async () => {
    const db = await openMemoryAdapter({ migrated: false })
    await migrate(db, { migrations: [v1, v2] })
    await expect(migrate(db, { migrations: [v1] })).rejects.toBeInstanceOf(SchemaTooNewError)
    expect(await currentVersion(db)).toBe(2)
  })

  it('rolls back a failed migration', async () => {
    const db = await openMemoryAdapter({ migrated: false })
    const bad = { version: 1, name: 'bad', up: ['CREATE TABLE a (x)', 'THIS IS NOT SQL'] }
    await expect(migrate(db, { migrations: [bad] })).rejects.toThrow()
    expect(await db.query(`SELECT name FROM sqlite_master WHERE name = 'a'`)).toEqual([])
    expect(await currentVersion(db)).toBe(0)
  })

  it('gives existing investment accounts the kind their tax type implies', async () => {
    const db = await openMemoryAdapter({ migrated: false })
    await migrate(db, { migrations: MIGRATIONS.slice(0, 9) })
    for (const [id, taxType] of [
      ['a', 'taxable'],
      ['b', '529'],
      ['c', 'roth'],
      ['d', 'traditional'],
    ] as const) {
      await db.exec(
        `INSERT INTO accounts (id, name, type, on_budget, created_at) VALUES (?, ?, 'investment', 0, 't')`,
        [id, id],
      )
      await db.exec(
        `INSERT INTO investment_accounts (id, tax_type, created_at) VALUES (?, ?, 't')`,
        [id, taxType],
      )
    }
    await migrate(db)
    expect(await db.query('SELECT id, kind FROM investment_accounts ORDER BY id')).toEqual([
      { id: 'a', kind: 'brokerage' },
      { id: 'b', kind: '529' },
      { id: 'c', kind: 'other' },
      { id: 'd', kind: 'other' },
    ])
  })

  it('indexes the transfer pair lookup that listing transactions does per row', async () => {
    const db = await openMemoryAdapter()
    const plan = await db.query<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT account_id FROM transactions p
         WHERE p.transfer_pair_id = 'x' AND p.id <> 'y'`,
    )
    expect(plan.map((r) => r.detail).join(' ')).toMatch(/USING INDEX transactions_transfer_pair/)
  })

  it('exposes the latest version', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS.length)
  })
})
