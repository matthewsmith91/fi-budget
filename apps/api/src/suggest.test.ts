import type Anthropic from '@anthropic-ai/sdk'
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { AuthError, createSession } from './auth.ts'
import { open } from './bank.ts'
import { openDatabase } from './db.ts'
import { checkSuggestions, createClaudeCategorizer } from './suggest.ts'

const ORIGIN = 'https://budget.example.com'
const NOW = Date.parse('2026-10-28T12:00:00Z')
const categories = [
  { id: 'c1', name: 'Groceries', group: 'Everyday' },
  { id: 'c2', name: 'Fuel', group: 'Car' },
]

describe('checkSuggestions', () => {
  it('keeps only known payees mapped to offered categories', () => {
    expect(
      checkSuggestions(
        { KROGER: 'c1', SHELL: 'c2', MYSTERY: null, INVENTED: 'c1', EVIL: 'c999' },
        ['KROGER', 'SHELL', 'MYSTERY', 'EVIL'],
        categories,
      ),
    ).toEqual({ KROGER: 'c1', SHELL: 'c2' })
  })
})

describe('createClaudeCategorizer', () => {
  function fakeClient(content: unknown, stop_reason = 'end_turn') {
    const calls: Record<string, unknown>[] = []
    const client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params)
          return { stop_reason, content }
        },
      },
    } as unknown as Pick<Anthropic, 'messages'>
    return { client, calls }
  }

  it('sends only payee names and category names, and reads the structured answer', async () => {
    const { client, calls } = fakeClient([
      {
        type: 'text',
        text: JSON.stringify({
          suggestions: [
            { payee: 'KROGER #1', categoryId: 'c1' },
            { payee: 'ZOO', categoryId: null },
          ],
        }),
      },
    ])
    const categorize = createClaudeCategorizer('sk-test', 'claude-test', client)
    expect(await categorize(['KROGER #1', 'ZOO'], categories)).toEqual({
      'KROGER #1': 'c1',
      ZOO: null,
    })
    const [call] = calls
    expect(call).toMatchObject({
      model: 'claude-test',
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    })
    expect(JSON.parse((call!.messages as { content: string }[])[0]!.content)).toEqual({
      payees: ['KROGER #1', 'ZOO'],
      categories,
    })
  })

  it('fails on a refusal or an answer that is not JSON', async () => {
    const refused = createClaudeCategorizer('k', 'm', fakeClient([], 'refusal').client)
    await expect(refused(['X'], categories)).rejects.toThrow(/stopped early/)
    const junk = createClaudeCategorizer(
      'k',
      'm',
      fakeClient([{ type: 'text', text: 'hi' }]).client,
    )
    await expect(junk(['X'], categories)).rejects.toThrow()
  })
})

describe('/api/suggest', () => {
  let db: DatabaseSync
  let server: Server
  let base: string
  let cookie: string
  let key: Buffer
  let asked: { apiKey: string; model: string; payees: string[]; categories: unknown[] }[]
  let checked: string[]
  let answer: Record<string, string | null>
  let rejectKey: boolean

  async function start(env?: { apiKey: string | null; model: string | null }) {
    server = createApp({
      db,
      staticDir: '/nonexistent',
      auth: { rpId: 'budget.example.com', origins: [ORIGIN], now: () => NOW },
      bank: { key },
      suggest: {
        env,
        check: async (apiKey) => {
          checked.push(apiKey)
          if (rejectKey) throw new AuthError(400, 'Anthropic did not accept that key')
        },
        make: (apiKey, model) => async (payees, cats) => {
          asked.push({ apiKey, model, payees, categories: cats })
          return answer
        },
      },
    }).listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (typeof address !== 'object' || !address) throw new Error('no address')
    base = `http://127.0.0.1:${address.port}`
  }

  beforeEach(() => {
    db = openDatabase(':memory:')
    key = randomBytes(32)
    asked = []
    checked = []
    answer = {}
    rejectKey = false
    db.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').run(
      'u1',
      'Matt',
      new Date(NOW).toISOString(),
    )
    cookie = `bf_session=${createSession(db, 'u1', NOW)}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    db.close()
  })

  const call = (method: string, path: string, body?: unknown, headers = { cookie }) =>
    fetch(`${base}/api/suggest${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const status = async () => (await call('GET', '/status')).json()
  const KEY = 'sk-ant-api03-abcdefghijklmnop1234'

  it('is off until a key is saved, and only signed-in people can ask', async () => {
    await start()
    expect(await status()).toEqual({
      enabled: false,
      source: null,
      model: 'claude-opus-5-5',
      keyHint: null,
    })
    expect((await call('GET', '/status', undefined, {} as never)).status).toBe(401)
    expect((await call('PUT', '/settings', { apiKey: KEY }, {} as never)).status).toBe(401)
    expect((await call('POST', '/categories', { payees: ['X'], categories })).status).toBe(404)
  })

  it('checks a key, stores it sealed, and never gives it back', async () => {
    await start()
    const res = await call('PUT', '/settings', { apiKey: `  ${KEY} ` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      enabled: true,
      source: 'settings',
      model: 'claude-opus-5-5',
      keyHint: '…1234',
    })
    expect(checked).toEqual([KEY])
    const stored = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('suggest.api_key') as {
      value: string
    }
    expect(stored.value).not.toContain('abcdefgh')
    expect(open(stored.value, key)).toBe(KEY)
    expect(JSON.stringify(await status())).not.toContain('abcdefgh')
  })

  it('stores nothing for a key Anthropic rejects or one that is not shaped like a key', async () => {
    await start()
    rejectKey = true
    expect((await call('PUT', '/settings', { apiKey: KEY })).status).toBe(400)
    rejectKey = false
    for (const apiKey of ['short', 'has spaces in it and is long enough', 5, '']) {
      expect((await call('PUT', '/settings', { apiKey })).status).toBe(400)
    }
    expect((await call('PUT', '/settings', {})).status).toBe(400)
    expect(db.prepare('SELECT COUNT(*) AS n FROM settings').get()).toEqual({ n: 0 })
    expect(await status()).toMatchObject({ enabled: false })
  })

  it('sets the model separately, and a blank one goes back to the default', async () => {
    await start()
    await call('PUT', '/settings', { apiKey: KEY, model: 'claude-haiku-5-5' })
    expect(await status()).toMatchObject({ model: 'claude-haiku-5-5' })
    expect((await call('PUT', '/settings', { model: 'bad model!' })).status).toBe(400)
    expect(await (await call('PUT', '/settings', { model: '' })).json()).toMatchObject({
      model: 'claude-opus-5-5',
      enabled: true,
    })
    // changing only the model does not re-check the key
    expect(checked).toHaveLength(1)
  })

  it('answers with checked suggestions using the saved key and model', async () => {
    await start()
    await call('PUT', '/settings', { apiKey: KEY, model: 'claude-test' })
    answer = { 'KROGER #1': 'c1', ZOO: 'c999', GHOST: 'c2' }
    const res = await call('POST', '/categories', {
      payees: ['KROGER #1', 'ZOO', 'KROGER #1'],
      categories,
    })
    expect(await res.json()).toEqual({ suggestions: { 'KROGER #1': 'c1' } })
    expect(asked).toMatchObject([
      { apiKey: KEY, model: 'claude-test', payees: ['KROGER #1', 'ZOO'] },
    ])
  })

  it('falls back to the server’s environment, which a saved key overrides', async () => {
    await start({ apiKey: 'sk-ant-from-the-environment-0000', model: 'claude-env' })
    expect(await status()).toEqual({
      enabled: true,
      source: 'environment',
      model: 'claude-env',
      keyHint: '…0000',
    })
    await call('POST', '/categories', { payees: ['X'], categories })
    expect(asked[0]).toMatchObject({
      apiKey: 'sk-ant-from-the-environment-0000',
      model: 'claude-env',
    })

    await call('PUT', '/settings', { apiKey: KEY })
    expect(await status()).toMatchObject({
      source: 'settings',
      keyHint: '…1234',
      model: 'claude-env',
    })

    expect(await (await call('DELETE', '/settings')).json()).toMatchObject({
      source: 'environment',
      keyHint: '…0000',
    })
  })

  it('turns off when the saved key is removed', async () => {
    await start()
    await call('PUT', '/settings', { apiKey: KEY, model: 'claude-test' })
    expect(await (await call('DELETE', '/settings')).json()).toEqual({
      enabled: false,
      source: null,
      model: 'claude-opus-5-5',
      keyHint: null,
    })
    expect((await call('POST', '/categories', { payees: ['X'], categories })).status).toBe(404)
  })

  it('ignores a saved key this server can no longer open', async () => {
    await start()
    await call('PUT', '/settings', { apiKey: KEY })
    key.fill(7) // as if the server’s key had changed
    expect(await status()).toMatchObject({ enabled: false, source: null })
  })

  it('refuses bad requests without asking the model', async () => {
    await start()
    await call('PUT', '/settings', { apiKey: KEY })
    for (const body of [
      {},
      { payees: [], categories },
      { payees: ['X'], categories: [] },
      { payees: [1], categories },
      { payees: Array.from({ length: 51 }, (_, i) => `P${i}`), categories },
      { payees: ['X'], categories: [{ id: 'c1' }] },
    ]) {
      expect((await call('POST', '/categories', body)).status).toBe(400)
    }
    expect(asked).toEqual([])
  })

  it('hides a model failure behind a plain message', async () => {
    await start()
    await call('PUT', '/settings', { apiKey: KEY })
    const throwing = createApp({
      db,
      staticDir: '/nonexistent',
      auth: { rpId: 'budget.example.com', origins: [ORIGIN], now: () => NOW },
      bank: { key },
      suggest: {
        make: () => async () => {
          throw new Error('401 invalid x-api-key sk-secret')
        },
      },
    }).listen(0)
    await new Promise((resolve) => throwing.once('listening', resolve))
    const address = throwing.address()
    if (typeof address !== 'object' || !address) throw new Error('no address')
    const res = await fetch(`http://127.0.0.1:${address.port}/api/suggest/categories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
      body: JSON.stringify({ payees: ['X'], categories }),
    })
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('sk-secret')
    throwing.closeAllConnections()
    await new Promise((resolve) => throwing.close(resolve))
  })
})
