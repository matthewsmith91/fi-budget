import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { MIGRATIONS, openDatabase } from './db.ts'

let dir: string
let db: DatabaseSync
let server: Server
let base: string

async function start(staticDir: string) {
  db = openDatabase(':memory:')
  server = createApp({
    db,
    staticDir,
    auth: { rpId: 'localhost', origins: ['http://localhost:5173'] },
    bank: { key: randomBytes(32) },
  }).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (typeof address !== 'object' || !address) throw new Error('no address')
  base = `http://127.0.0.1:${address.port}`
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'budget-fi-static-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Budget</title>')
  writeFileSync(join(dir, 'sw.js'), '// service worker')
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)')
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('server', () => {
  it('reports health and the schema version', async () => {
    await start(dir)
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', schemaVersion: MIGRATIONS.length })
  })

  it('serves the app shell at the root and for client-side routes', async () => {
    await start(dir)
    for (const path of ['/', '/budget/2026-01']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(await res.text()).toContain('<title>Budget</title>')
    }
  })

  it('caches hashed assets forever but makes the service worker revalidate', async () => {
    await start(dir)
    const asset = await fetch(`${base}/assets/app-abc123.js`)
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    const sw = await fetch(`${base}/sw.js`)
    expect(sw.headers.get('cache-control')).toBe('no-cache')
    const shell = await fetch(`${base}/`)
    expect(shell.headers.get('cache-control')).toBe('no-cache')
  })

  it('answers unknown /api paths with JSON 404, not the app shell', async () => {
    await start(dir)
    const res = await fetch(`${base}/api/nope`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('sets basic security headers and hides Express', async () => {
    await start(dir)
    const res = await fetch(`${base}/health`)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('x-powered-by')).toBeNull()
  })

  it('still runs the API when the web app has not been built', async () => {
    await start(join(dir, 'missing'))
    expect((await fetch(`${base}/health`)).status).toBe(200)
    expect((await fetch(`${base}/`)).status).toBe(404)
  })
})
