import { describe, expect, it } from 'vitest'
import { createBudgetApi, type BudgetApi } from './api.ts'
import { LATEST_SCHEMA_VERSION, SchemaTooNewError } from './migrations.ts'
import { connect, RpcError, serve, type RpcMethods } from './rpc.ts'
import { openMemoryAdapter } from './test-utils.ts'

async function makeApi() {
  const adapter = await openMemoryAdapter()
  let n = 0
  return createBudgetApi({
    adapter,
    storage: 'memory',
    sqliteVersion: 'test',
    newId: () => `id-${++n}`,
    now: () => '2026-01-01T00:00:00.000Z',
  })
}

describe('BudgetApi', () => {
  it('reports status', async () => {
    const api = await makeApi()
    expect(await api.getStatus()).toEqual({
      schemaVersion: LATEST_SCHEMA_VERSION,
      sqliteVersion: 'test',
      storage: 'memory',
    })
  })

  it('creates one household with members, once', async () => {
    const api = await makeApi()
    expect(await api.getHousehold()).toBeNull()
    const h = await api.createHousehold({ name: ' Smith ', members: ['Matt', ' Jessica ', ''] })
    expect(h).toEqual({
      id: 'id-1',
      name: 'Smith',
      members: [
        { id: 'id-2', displayName: 'Matt' },
        { id: 'id-3', displayName: 'Jessica' },
      ],
    })
    await expect(api.createHousehold({ name: 'Again', members: ['X'] })).rejects.toThrow(
      /already has/,
    )
    await expect(
      makeApi().then((a) => a.createHousehold({ name: '', members: ['x'] })),
    ).rejects.toThrow(/name/)
  })

  it('imports with a safety backup of what was replaced, and exports round-trip', async () => {
    const a = await makeApi()
    await a.createHousehold({ name: 'Smith', members: ['Matt', 'Jessica'] })
    const json = await a.exportJson()
    const sqlite = await a.exportSqlite()

    const b = await makeApi()
    await b.createHousehold({ name: 'Other', members: ['Pat'] })
    const { safetyBackup } = await b.importJson(json)
    expect((await b.getHousehold())?.name).toBe('Smith')

    const c = await makeApi()
    await c.importSqlite(safetyBackup)
    expect((await c.getHousehold())?.name).toBe('Other')
    await c.importSqlite(sqlite)
    expect((await c.getHousehold())?.members.map((m) => m.displayName)).toEqual(['Matt', 'Jessica'])
  })
})

describe('rpc', () => {
  it('round-trips calls, binary data and errors through the one message API', async () => {
    const api = await makeApi()
    const { port1, port2 } = new MessageChannel()
    serve(api as unknown as RpcMethods, port1 as never)
    const client = connect<BudgetApi & RpcMethods>(port2 as never)
    try {
      expect((await client.getStatus()).schemaVersion).toBe(LATEST_SCHEMA_VERSION)
      await client.createHousehold({ name: 'Smith', members: ['Matt'] })
      const bytes = await client.exportSqlite()
      expect(bytes).toBeInstanceOf(Uint8Array)
      const err = await client.createHousehold({ name: 'Smith', members: ['Matt'] }).catch((e) => e)
      expect(err).toBeInstanceOf(RpcError)
      expect(err.message).toMatch(/already has/)
      await expect(client.nope()).rejects.toThrow(/Unknown method/)
      await expect(client.constructor()).rejects.toThrow(/Unknown method/)
    } finally {
      port1.close()
      port2.close()
    }
  })

  it('queues requests until the api has loaded, and surfaces load failures', async () => {
    const { port1, port2 } = new MessageChannel()
    let release!: (m: RpcMethods) => void
    serve(new Promise<RpcMethods>((r) => (release = r)), port1 as never)
    const client = connect<{ hello(): Promise<string> }>(port2 as never)
    const reply = client.hello()
    release({ hello: async () => 'hi' })
    expect(await reply).toBe('hi')

    const failing = new MessageChannel()
    const failed = Promise.reject(new SchemaTooNewError(9, 1))
    failed.catch(() => {})
    serve(failed, failing.port1 as never)
    const c2 = connect<{ hello(): Promise<string> }>(failing.port2 as never)
    await expect(c2.hello()).rejects.toMatchObject({ name: 'SchemaTooNewError' })
    for (const p of [port1, port2, failing.port1, failing.port2]) p.close()
  })
})
