import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { openMemoryAdapter } from './test-utils.ts'

async function makeApi() {
  const adapter = await openMemoryAdapter()
  let n = 0
  const api = createBudgetApi({
    adapter,
    storage: 'memory',
    sqliteVersion: 'test',
    newId: () => `id-${++n}`,
    now: () => '2026-10-28T00:00:00.000Z',
  })
  const household = await api.createHousehold({ name: 'Smith', members: ['Matt', 'Jessica'] })
  const [matt, jessica] = household.members as [
    { id: string; displayName: string },
    { id: string; displayName: string },
  ]
  const checking = await api.createAccount({ name: 'Checking', type: 'checking' })
  const brokerage = await api.createAccount({ name: 'Brokerage', type: 'investment' })
  return { api, adapter, matt, jessica, checking, brokerage }
}

describe('investment account settings', () => {
  it('starts a new investment account as taxable, joint and in units mode', async () => {
    const { api, brokerage } = await makeApi()
    expect(await api.listInvestmentAccounts()).toEqual([
      {
        accountId: brokerage.id,
        name: 'Brokerage',
        closed: false,
        kind: 'brokerage',
        taxType: 'taxable',
        ownerId: null,
        mode: 'units',
        latestValuation: null,
      },
    ])
  })

  it('takes settings when the account is created', async () => {
    const { api, matt } = await makeApi()
    const roth = await api.createAccount({
      name: 'Matt Roth',
      type: 'investment',
      investment: { kind: 'ira', taxType: 'roth', ownerId: matt.id },
    })
    const listed = (await api.listInvestmentAccounts()).find((a) => a.accountId === roth.id)
    expect(listed).toMatchObject({ kind: 'ira', taxType: 'roth', ownerId: matt.id, mode: 'units' })
  })

  it('gives a new account its kind’s usual tax type when only the kind is chosen', async () => {
    const { api } = await makeApi()
    const make = async (name: string, kind: 'ira' | '401k' | '529' | 'other') => {
      const a = await api.createAccount({ name, type: 'investment', investment: { kind } })
      return (await api.listInvestmentAccounts()).find((x) => x.accountId === a.id)
    }
    expect(await make('IRA', 'ira')).toMatchObject({ kind: 'ira', taxType: 'traditional' })
    expect(await make('Plan', '401k')).toMatchObject({ kind: '401k', taxType: 'traditional' })
    expect(await make('College', '529')).toMatchObject({ kind: '529', taxType: '529' })
    expect(await make('Misc', 'other')).toMatchObject({ kind: 'other', taxType: 'taxable' })
  })

  it('changes tax type, owner and mode, and clears the owner', async () => {
    const { api, brokerage, jessica } = await makeApi()
    const changed = await api.updateInvestmentSettings(brokerage.id, {
      kind: '529',
      ownerId: jessica.id,
      mode: 'holdings',
    })
    expect(changed).toMatchObject({
      kind: '529',
      taxType: '529',
      ownerId: jessica.id,
      mode: 'holdings',
    })
    const joint = await api.updateInvestmentSettings(brokerage.id, { ownerId: null })
    expect(joint).toMatchObject({ kind: '529', taxType: '529', ownerId: null, mode: 'holdings' })
  })

  it('moves to the new kind’s usual tax type when the old one no longer fits', async () => {
    const { api, brokerage } = await makeApi()
    expect(await api.updateInvestmentSettings(brokerage.id, { kind: '401k' })).toMatchObject({
      kind: '401k',
      taxType: 'traditional',
    })
    expect(await api.updateInvestmentSettings(brokerage.id, { taxType: 'roth' })).toMatchObject({
      taxType: 'roth',
    })
    // Roth still fits an IRA, so it stays
    expect(await api.updateInvestmentSettings(brokerage.id, { kind: 'ira' })).toMatchObject({
      kind: 'ira',
      taxType: 'roth',
    })
    expect(await api.updateInvestmentSettings(brokerage.id, { kind: 'brokerage' })).toMatchObject({
      taxType: 'taxable',
    })
  })

  it('refuses a tax type the kind can’t have', async () => {
    const { api, brokerage } = await makeApi()
    await expect(api.updateInvestmentSettings(brokerage.id, { taxType: 'roth' })).rejects.toThrow(
      'A brokerage account can’t be roth',
    )
    await expect(
      api.updateInvestmentSettings(brokerage.id, { kind: '401k', taxType: 'taxable' }),
    ).rejects.toThrow('A 401(k) can’t be taxable')
    await expect(
      api.createAccount({
        name: 'Bad',
        type: 'investment',
        investment: { kind: '529', taxType: 'roth' },
      }),
    ).rejects.toThrow('A 529 plan can’t be roth')
    expect((await api.listInvestmentAccounts()).map((a) => a.name)).toEqual(['Brokerage'])
  })

  it('refuses an unknown tax type, mode or owner', async () => {
    const { api, brokerage } = await makeApi()
    await expect(
      api.updateInvestmentSettings(brokerage.id, { taxType: 'hsa' as never }),
    ).rejects.toThrow('Unknown tax type')
    await expect(
      api.updateInvestmentSettings(brokerage.id, { mode: 'lots' as never }),
    ).rejects.toThrow('Unknown mode')
    await expect(
      api.updateInvestmentSettings(brokerage.id, { kind: 'hsa' as never }),
    ).rejects.toThrow('Unknown account kind')
    await expect(api.updateInvestmentSettings(brokerage.id, { ownerId: 'nobody' })).rejects.toThrow(
      'Owner not found',
    )
  })

  it('only applies to investment accounts', async () => {
    const { api, checking } = await makeApi()
    await expect(api.updateInvestmentSettings(checking.id, { taxType: 'roth' })).rejects.toThrow(
      'not an investment account',
    )
    expect((await api.listInvestmentAccounts()).map((a) => a.accountId)).not.toContain(checking.id)
  })

  it('gives an investment account without a settings row the defaults, and makes the row on first change', async () => {
    const { api, adapter, brokerage } = await makeApi()
    // an account from before settings existed, or one the YNAB import created
    await adapter.exec('DELETE FROM investment_accounts WHERE id = ?', [brokerage.id])
    expect((await api.listInvestmentAccounts())[0]).toMatchObject({ taxType: 'taxable' })
    await api.updateInvestmentSettings(brokerage.id, { kind: 'ira', taxType: 'traditional' })
    expect((await api.listInvestmentAccounts())[0]).toMatchObject({
      kind: 'ira',
      taxType: 'traditional',
    })
  })

  it('logs the settings as change messages', async () => {
    const { api, adapter, brokerage } = await makeApi()
    await api.updateInvestmentSettings(brokerage.id, { kind: 'ira', taxType: 'roth' })
    const rows = await adapter.query(
      `SELECT column_name, value FROM messages
       WHERE table_name = 'investment_accounts' AND row_id = ? ORDER BY timestamp DESC LIMIT 1`,
      [brokerage.id],
    )
    expect(rows).toEqual([{ column_name: 'tax_type', value: 'roth' }])
  })
})

describe('valuations', () => {
  it('records a manual valuation and shows the newest on the account', async () => {
    const { api, brokerage } = await makeApi()
    await api.recordValuation({
      accountId: brokerage.id,
      date: '2026-09-30',
      marketValue: 80_000_00,
    })
    const newest = await api.recordValuation({
      accountId: brokerage.id,
      date: '2026-10-31',
      marketValue: 84_200_00,
    })
    expect(newest).toMatchObject({ date: '2026-10-31', marketValue: 84_200_00, source: 'manual' })
    expect((await api.listValuations(brokerage.id)).map((v) => v.date)).toEqual([
      '2026-10-31',
      '2026-09-30',
    ])
    expect((await api.listInvestmentAccounts())[0]!.latestValuation).toEqual(newest)
  })

  it('keeps one value per day: recording the day again corrects it', async () => {
    const { api, brokerage } = await makeApi()
    const first = await api.recordValuation({
      accountId: brokerage.id,
      date: '2026-10-31',
      marketValue: 84_200_00,
    })
    const second = await api.recordValuation({
      accountId: brokerage.id,
      date: '2026-10-31',
      marketValue: 84_250_00,
    })
    expect(second.id).toBe(first.id)
    expect(await api.listValuations(brokerage.id)).toEqual([second])
  })

  it('accepts zero but not a negative, fractional or unsafe amount, or a bad date', async () => {
    const { api, brokerage } = await makeApi()
    const input = { accountId: brokerage.id, date: '2026-10-31' }
    await expect(api.recordValuation({ ...input, marketValue: 0 })).resolves.toBeTruthy()
    for (const marketValue of [-1, 10.5, Number.NaN, 2 ** 60]) {
      await expect(api.recordValuation({ ...input, marketValue })).rejects.toThrow('whole number')
    }
    await expect(
      api.recordValuation({ accountId: brokerage.id, date: '10/31/2026', marketValue: 1 }),
    ).rejects.toThrow()
  })

  it('only values investment accounts', async () => {
    const { api, checking } = await makeApi()
    await expect(
      api.recordValuation({ accountId: checking.id, date: '2026-10-31', marketValue: 1 }),
    ).rejects.toThrow('not an investment account')
  })

  it('deletes a valuation', async () => {
    const { api, brokerage } = await makeApi()
    const v = await api.recordValuation({
      accountId: brokerage.id,
      date: '2026-10-31',
      marketValue: 5,
    })
    await api.deleteValuation(v.id)
    expect(await api.listValuations(brokerage.id)).toEqual([])
    await expect(api.deleteValuation(v.id)).rejects.toThrow('not found')
  })

  it('goes with the account when the account is deleted', async () => {
    const { api, adapter, brokerage } = await makeApi()
    await api.recordValuation({ accountId: brokerage.id, date: '2026-10-31', marketValue: 5 })
    await api.deleteAccount(brokerage.id)
    expect(await adapter.query('SELECT 1 FROM account_valuations')).toEqual([])
    expect(await adapter.query('SELECT 1 FROM investment_accounts')).toEqual([])
  })
})

describe('valuations from the bank', () => {
  const balance = (externalId: string, amount: number, balanceDate: string | null) => ({
    externalId,
    balance: amount,
    balanceDate,
  })

  it('records the balance of a linked investment account on the day the bank gave', async () => {
    const { api, brokerage } = await makeApi()
    await api.mapExternalAccount({ externalId: 'ACT-9', name: 'Fidelity', accountId: brokerage.id })
    const written = await api.recordBankBalances([
      balance('ACT-9', 84_200_00, '2026-10-27T21:30:00.000Z'),
    ])
    expect(written).toBe(1)
    expect(await api.listValuations(brokerage.id)).toMatchObject([
      { date: '2026-10-27', marketValue: 84_200_00, source: 'sync' },
    ])
  })

  it('uses today when the bank did not say when', async () => {
    const { api, brokerage } = await makeApi()
    await api.mapExternalAccount({ externalId: 'ACT-9', name: 'Fidelity', accountId: brokerage.id })
    await api.recordBankBalances([balance('ACT-9', 1_00, null)])
    expect((await api.listValuations(brokerage.id))[0]!.date).toBe('2026-10-28')
  })

  it('ignores unlinked accounts and accounts that are not investments', async () => {
    const { api, checking, brokerage } = await makeApi()
    await api.mapExternalAccount({ externalId: 'ACT-1', name: 'Chase', accountId: checking.id })
    await api.mapExternalAccount({ externalId: 'ACT-9', name: 'Fidelity', accountId: null })
    const written = await api.recordBankBalances([
      balance('ACT-1', 100, null),
      balance('ACT-9', 100, null),
      balance('ACT-404', 100, null),
    ])
    expect(written).toBe(0)
    expect(await api.listValuations(brokerage.id)).toEqual([])
  })

  it('skips a closed account and a balance below zero', async () => {
    const { api, brokerage } = await makeApi()
    await api.mapExternalAccount({ externalId: 'ACT-9', name: 'Fidelity', accountId: brokerage.id })
    expect(await api.recordBankBalances([balance('ACT-9', -5, null)])).toBe(0)
    await api.updateAccount(brokerage.id, { closed: true })
    expect(await api.recordBankBalances([balance('ACT-9', 5, null)])).toBe(0)
  })

  it('refreshes an earlier bank value for the day but never a typed one', async () => {
    const { api, brokerage } = await makeApi()
    await api.mapExternalAccount({ externalId: 'ACT-9', name: 'Fidelity', accountId: brokerage.id })
    await api.recordBankBalances([balance('ACT-9', 100, '2026-10-27T10:00:00.000Z')])
    await api.recordBankBalances([balance('ACT-9', 120, '2026-10-27T18:00:00.000Z')])
    expect((await api.listValuations(brokerage.id))[0]).toMatchObject({
      marketValue: 120,
      source: 'sync',
    })

    await api.recordValuation({ accountId: brokerage.id, date: '2026-10-27', marketValue: 130 })
    expect(await api.recordBankBalances([balance('ACT-9', 140, '2026-10-27T23:00:00.000Z')])).toBe(
      0,
    )
    expect((await api.listValuations(brokerage.id))[0]).toMatchObject({
      marketValue: 130,
      source: 'manual',
    })
  })
})
