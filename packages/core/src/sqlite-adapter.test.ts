import { describe, expect, it } from 'vitest'
import { openMemoryAdapter } from './test-utils.ts'

describe('SqliteAdapter', () => {
  it('runs parameterized queries and returns plain objects', async () => {
    const db = await openMemoryAdapter({ migrated: false })
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, amt INTEGER)')
    await db.exec('INSERT INTO t (name, amt) VALUES (?, ?)', ['a', 1250])
    const rows = await db.query<{ id: number; name: string; amt: number }>('SELECT * FROM t')
    expect(rows).toEqual([{ id: 1, name: 'a', amt: 1250 }])
    expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype)
  })

  it('commits a transaction and rolls back on error', async () => {
    const db = await openMemoryAdapter({ migrated: false })
    await db.exec('CREATE TABLE t (n INTEGER)')
    await db.transaction(async (tx) => tx.exec('INSERT INTO t VALUES (1)'))
    await expect(
      db.transaction(async (tx) => {
        await tx.exec('INSERT INTO t VALUES (2)')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await db.query('SELECT n FROM t')).toEqual([{ n: 1 }])
  })

  it('serializes concurrent transactions', async () => {
    const db = await openMemoryAdapter({ migrated: false })
    await db.exec('CREATE TABLE t (n INTEGER)')
    await Promise.all(
      [1, 2, 3].map((n) =>
        db.transaction(async (tx) => {
          await new Promise((r) => setTimeout(r, 5 - n))
          await tx.exec('INSERT INTO t VALUES (?)', [n])
        }),
      ),
    )
    expect(await db.query('SELECT n FROM t ORDER BY rowid')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('enforces foreign keys unless disabled for a transaction', async () => {
    const db = await openMemoryAdapter({ migrated: false })
    await db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY)')
    await db.exec('CREATE TABLE c (pid INTEGER REFERENCES p(id))')
    await expect(db.exec('INSERT INTO c VALUES (9)')).rejects.toThrow()
    // with FKs off, a violation that is still present at commit aborts the transaction
    await expect(
      db.transaction(async (tx) => tx.exec('INSERT INTO c VALUES (9)'), { foreignKeys: false }),
    ).rejects.toThrow(/Foreign key violations/)
    // ...but a temporary violation that is repaired before commit is allowed
    await db.transaction(
      async (tx) => {
        await tx.exec('INSERT INTO c VALUES (9)')
        await tx.exec('INSERT INTO p VALUES (9)')
      },
      { foreignKeys: false },
    )
    expect(await db.query('SELECT * FROM c')).toEqual([{ pid: 9 }])
  })

  it('exports and imports the whole file', async () => {
    const a = await openMemoryAdapter({ migrated: false })
    await a.exec('CREATE TABLE t (n INTEGER)')
    await a.exec('INSERT INTO t VALUES (42)')
    const bytes = await a.exportFile()
    const b = await openMemoryAdapter({ migrated: false })
    await b.importFile(bytes)
    expect(await b.query('SELECT n FROM t')).toEqual([{ n: 42 }])
    // still writable after import
    await b.exec('INSERT INTO t VALUES (43)')
    expect(await b.query('SELECT COUNT(*) AS c FROM t')).toEqual([{ c: 2 }])
  })

  it('rejects imports that are not SQLite files', async () => {
    const db = await openMemoryAdapter({ migrated: false })
    await expect(
      db.importFile(new TextEncoder().encode('hello world, not sqlite!')),
    ).rejects.toThrow(/Not a SQLite/)
  })
})
