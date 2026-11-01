import { describe, expect, it } from 'vitest'
import { createBudgetApi } from './api.ts'
import { planStatuses, type Relationship } from './profiles.ts'
import { openMemoryAdapter } from './test-utils.ts'

async function makeApi(members = ['Matt', 'Jessica']) {
  const adapter = await openMemoryAdapter()
  let n = 0
  let tick = 0
  const api = createBudgetApi({
    adapter,
    storage: 'memory',
    sqliteVersion: 'test',
    newId: () => `id-${++n}`,
    // a clock that moves on, as the real one does, so "added later" sorts later
    now: () => new Date(Date.UTC(2026, 9, 28) + ++tick * 1000).toISOString(),
  })
  await api.createHousehold({ name: 'Smith', members })
  const people = await api.listProfiles()
  return { api, adapter, people }
}

describe('profiles', () => {
  it('gives each household member a profile with defaults', async () => {
    const { people } = await makeApi()
    expect(people.map((p) => p.displayName)).toEqual(['Matt', 'Jessica'])
    expect(people[0]).toMatchObject({
      birthMonth: null,
      retirementAge: 65,
      monthlyContribution: 0,
      annualIncome: 0,
      incomeGrowth: 3,
      contributionFollowsRaises: false,
      socialSecurityMonthly: 0,
      socialSecurityAge: 67,
      pensionMonthly: 0,
      pensionAge: 65,
      links: [],
    })
  })

  it('adds a person who was not in the household at setup', async () => {
    const { api } = await makeApi()
    const sam = await api.createProfile({
      displayName: '  Sam ',
      birthMonth: '1999-03',
      annualIncome: 55_000_00,
    })
    expect(sam).toMatchObject({
      displayName: 'Sam',
      birthMonth: '1999-03',
      annualIncome: 55_000_00,
    })
    expect((await api.getHousehold())!.members.map((m) => m.displayName)).toEqual([
      'Matt',
      'Jessica',
      'Sam',
    ])
    await expect(api.createProfile({ displayName: 'sam' })).rejects.toThrow(/already someone/)
    await expect(api.createProfile({ displayName: ' ' })).rejects.toThrow(/name is required/)
  })

  it('needs a household first', async () => {
    const adapter = await openMemoryAdapter()
    const api = createBudgetApi({ adapter, storage: 'memory', sqliteVersion: 'test' })
    await expect(api.createProfile({ displayName: 'Matt' })).rejects.toThrow(/household/)
  })

  it('updates settings and name, keeping what is not mentioned', async () => {
    const { api, people } = await makeApi()
    const matt = people[0]!
    await api.updateProfile(matt.id, {
      birthMonth: '1988-04',
      retirementAge: 60,
      monthlyContribution: 1_100_00,
      contributionFollowsRaises: true,
      incomeGrowth: 3.456,
    })
    const saved = await api.updateProfile(matt.id, { displayName: 'Matthew', annualIncome: 1_00 })
    expect(saved).toMatchObject({
      displayName: 'Matthew',
      birthMonth: '1988-04',
      retirementAge: 60,
      monthlyContribution: 1_100_00,
      contributionFollowsRaises: true,
      incomeGrowth: 3.46,
      annualIncome: 1_00,
    })
    await expect(api.updateProfile(matt.id, { displayName: 'Jessica' })).rejects.toThrow(
      /already someone/,
    )
    await expect(api.updateProfile('nobody', { annualIncome: 1 })).rejects.toThrow(/not found/)
  })

  it('refuses values that make no sense', async () => {
    const { api, people } = await makeApi()
    const id = people[0]!.id
    const bad = (changes: Parameters<typeof api.updateProfile>[1], message: RegExp) =>
      expect(api.updateProfile(id, changes)).rejects.toThrow(message)
    await bad({ birthMonth: '1991-13' }, /month/i)
    await bad({ retirementAge: 20 }, /retirement age/)
    await bad({ retirementAge: 65.5 }, /whole/)
    await bad({ monthlyContribution: -1 }, /contribution/)
    await bad({ annualIncome: 10.5 }, /income/)
    await bad({ incomeGrowth: 50 }, /raise/)
    await bad({ socialSecurityAge: 60 }, /Social Security age/)
    await bad({ socialSecurityMonthly: -5 }, /Social Security/)
    await bad({ pensionAge: 95 }, /pension age/)
    await bad({ pensionMonthly: 1.5 }, /pension/)
  })

  it('removes a person nothing refers to, and never the last one', async () => {
    const { api, people } = await makeApi()
    const [matt, jessica] = people as [(typeof people)[0], (typeof people)[0]]
    await api.linkProfiles({
      memberId: matt.id,
      relatedMemberId: jessica.id,
      relationship: 'spouse',
    })
    await api.deleteProfile(jessica.id)
    const left = await api.listProfiles()
    expect(left.map((p) => p.displayName)).toEqual(['Matt'])
    expect(left[0]!.links).toEqual([])
    await expect(api.deleteProfile(matt.id)).rejects.toThrow(/at least one/)
  })

  it('keeps a person who a device, an account or a contribution limit names', async () => {
    const { api, people } = await makeApi(['Matt', 'Jessica', 'Sam', 'Pat'])
    const [, jessica, sam, pat] = people
    await api.setDevice({ name: 'Laptop', memberId: jessica!.id })
    await api.createAccount({
      name: 'Sam IRA',
      type: 'investment',
      investment: { kind: 'ira', taxType: 'roth', ownerId: sam!.id },
    })
    await api.setContributionLimit({ memberId: pat!.id, year: 2026, limit: 8_000_00 })
    await expect(api.deleteProfile(jessica!.id)).rejects.toThrow(/device/)
    await expect(api.deleteProfile(sam!.id)).rejects.toThrow(/investment account/)
    await expect(api.deleteProfile(pat!.id)).rejects.toThrow(/contribution limit/)
  })
})

describe('links', () => {
  it('links two people both ways, changes how, and unlinks', async () => {
    const { api, people } = await makeApi()
    const [matt, jessica] = people as [(typeof people)[0], (typeof people)[0]]
    await api.linkProfiles({
      memberId: jessica.id,
      relatedMemberId: matt.id,
      relationship: 'partner',
    })
    let [m, j] = await api.listProfiles()
    expect(m!.links).toEqual([
      { memberId: jessica.id, displayName: 'Jessica', relationship: 'partner' },
    ])
    expect(j!.links).toEqual([{ memberId: matt.id, displayName: 'Matt', relationship: 'partner' }])

    await api.linkProfiles({
      memberId: matt.id,
      relatedMemberId: jessica.id,
      relationship: 'spouse',
    })
    ;[m, j] = await api.listProfiles()
    expect(m!.links[0]!.relationship).toBe('spouse')
    expect(j!.links[0]!.relationship).toBe('spouse')

    await api.unlinkProfiles({ memberId: jessica.id, relatedMemberId: matt.id })
    ;[m, j] = await api.listProfiles()
    expect([m!.links, j!.links]).toEqual([[], []])
    await expect(
      api.unlinkProfiles({ memberId: jessica.id, relatedMemberId: matt.id }),
    ).rejects.toThrow(/not linked/)
  })

  it('refuses a link to oneself, to a stranger or with no relationship', async () => {
    const { api, people } = await makeApi()
    const id = people[0]!.id
    await expect(
      api.linkProfiles({ memberId: id, relatedMemberId: id, relationship: 'spouse' }),
    ).rejects.toThrow(/themselves/)
    await expect(
      api.linkProfiles({ memberId: id, relatedMemberId: 'nobody', relationship: 'spouse' }),
    ).rejects.toThrow(/not found/)
    await expect(
      api.linkProfiles({
        memberId: id,
        relatedMemberId: people[1]!.id,
        relationship: 'cousin' as never,
      }),
    ).rejects.toThrow(/related/)
  })
})

describe('planStatuses (pure)', () => {
  const people = [
    { id: 'a', birthMonth: '1988-04' },
    { id: 'b', birthMonth: '1990-09' },
    { id: 'c', birthMonth: null },
    { id: 'd', birthMonth: '2001-01' },
  ]
  const link = (
    memberId: string,
    relatedMemberId: string,
    relationship: Relationship = 'spouse',
  ) => ({
    memberId,
    relatedMemberId,
    relationship,
  })

  it('counts the first person with a birth month and nobody else without a link', () => {
    const s = planStatuses(people, [])
    expect(s.get('a')).toEqual({ included: true, note: null })
    expect(s.get('b')).toMatchObject({
      included: false,
      note: expect.stringMatching(/not linked/i),
    })
    expect(s.get('c')).toMatchObject({
      included: false,
      note: expect.stringMatching(/birth month/),
    })
  })

  it('follows spouse and partner links, in either direction and through other people', () => {
    const s = planStatuses(people, [link('b', 'a'), link('d', 'b', 'partner')])
    expect([...s.values()].map((v) => v.included)).toEqual([true, true, false, true])
  })

  it('does not follow a relative link, or one through someone with no birth month', () => {
    const s = planStatuses(people, [link('a', 'b', 'relative'), link('a', 'c'), link('c', 'd')])
    expect([...s.values()].map((v) => v.included)).toEqual([true, false, false, false])
  })

  it('counts nobody until someone has a birth month', () => {
    const s = planStatuses([{ id: 'a', birthMonth: null }], [])
    expect(s.get('a')).toMatchObject({ included: false })
  })
})
