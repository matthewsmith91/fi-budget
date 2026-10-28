import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, openDatabase, schemaVersion } from './db.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'budget-fi-db-'))
  dirs.push(dir)
  return join(dir, 'nested', 'server.sqlite')
}

describe('openDatabase', () => {
  it('creates the file and its directory, at the latest version', () => {
    const db = openDatabase(tempFile())
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    db.close()
  })

  it('applies migrations in order and only once', () => {
    const file = tempFile()
    const migrations = ['CREATE TABLE a (id TEXT)', 'CREATE TABLE b (id TEXT)']
    const first = openDatabase(file, migrations)
    expect(schemaVersion(first)).toBe(2)
    first.close()

    const second = openDatabase(file, migrations)
    expect(schemaVersion(second)).toBe(2)
    second.close()
  })

  it('runs only the migrations a file has not seen', () => {
    const file = tempFile()
    openDatabase(file, ['CREATE TABLE a (id TEXT)']).close()
    const db = openDatabase(file, ['CREATE TABLE a (id TEXT)', 'CREATE TABLE b (id TEXT)'])
    expect(schemaVersion(db)).toBe(2)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").all()).toHaveLength(1)
    db.close()
  })

  it('rolls back a failing migration and reports which one failed', () => {
    const file = tempFile()
    expect(() =>
      openDatabase(file, ['CREATE TABLE a (id TEXT)', 'CREATE TABLE a (id TEXT)']),
    ).toThrow('Migration 2 failed')
    const db = openDatabase(file, ['CREATE TABLE a (id TEXT)'])
    expect(schemaVersion(db)).toBe(1)
    db.close()
  })

  it('refuses a file from a newer schema', () => {
    const file = tempFile()
    openDatabase(file, ['CREATE TABLE a (id TEXT)', 'CREATE TABLE b (id TEXT)']).close()
    expect(() => openDatabase(file, ['CREATE TABLE a (id TEXT)'])).toThrow(/newer version/)
  })
})
