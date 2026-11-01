import { assertMonth, type Month } from './allocations.ts'
import { cleanName, flag, type CrudDeps } from './crud.ts'
import type { SqlRunner } from './storage.ts'

export const RETIREMENT_AGE_RANGE = { min: 40, max: 90, default: 65 } as const
export const SOCIAL_SECURITY_AGE_RANGE = { min: 62, max: 70, default: 67 } as const
export const PENSION_AGE_RANGE = { min: 40, max: 90, default: 65 } as const
export const INCOME_GROWTH_RANGE = { min: -5, max: 20, default: 3 } as const

/** `spouse` and `partner` share finances in the retirement plan; `relative` is a record only. */
export const RELATIONSHIPS = ['spouse', 'partner', 'relative'] as const
export type Relationship = (typeof RELATIONSHIPS)[number]

export const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  spouse: 'Spouse',
  partner: 'Partner',
  relative: 'Relative',
}

/** Whether a link makes two people one retirement plan. */
export const sharesFinances = (relationship: Relationship) =>
  relationship === 'spouse' || relationship === 'partner'

/** What a person's profile holds. Money is integer cents in today's dollars. */
export interface ProfileSettings {
  /** Their birth month; there is no retirement projection for someone without one. */
  birthMonth: Month | null
  /** The age they stop working. */
  retirementAge: number
  /** Cents a month they put into retirement accounts until they retire. */
  monthlyContribution: number
  /** Gross income a year, today. */
  annualIncome: number
  /** Their usual yearly raise before inflation, in percent. */
  incomeGrowth: number
  /** Whether the contribution grows with raises that beat inflation (otherwise it stays flat). */
  contributionFollowsRaises: boolean
  /** Estimated Social Security a month in today's dollars, from `socialSecurityAge`. */
  socialSecurityMonthly: number
  socialSecurityAge: number
  /** A pension a month in today's dollars, from `pensionAge`. */
  pensionMonthly: number
  pensionAge: number
}

export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  birthMonth: null,
  retirementAge: RETIREMENT_AGE_RANGE.default,
  monthlyContribution: 0,
  annualIncome: 0,
  incomeGrowth: INCOME_GROWTH_RANGE.default,
  contributionFollowsRaises: false,
  socialSecurityMonthly: 0,
  socialSecurityAge: SOCIAL_SECURITY_AGE_RANGE.default,
  pensionMonthly: 0,
  pensionAge: PENSION_AGE_RANGE.default,
}

export interface ProfileLink {
  /** The other person. */
  memberId: string
  displayName: string
  relationship: Relationship
}

/** Whether the retirement plan counts a person, and if not, what to change. */
export interface PlanStatus {
  included: boolean
  note: string | null
}

export interface Profile extends ProfileSettings {
  id: string
  displayName: string
  links: ProfileLink[]
  plan: PlanStatus
}

export interface ProfilesApi {
  /** Everyone in the household, oldest first, with their links and plan status. */
  listProfiles(): Promise<Profile[]>
  /** Adds a person. Anything not given takes its default. */
  createProfile(input: { displayName: string } & Partial<ProfileSettings>): Promise<Profile>
  updateProfile(
    id: string,
    changes: Partial<ProfileSettings> & { displayName?: string },
  ): Promise<Profile>
  /** Removes a person who isn't named by a device, an account or a contribution limit. */
  deleteProfile(id: string): Promise<void>
  /** Links two people, or changes how they are linked. */
  linkProfiles(input: {
    memberId: string
    relatedMemberId: string
    relationship: Relationship
  }): Promise<void>
  unlinkProfiles(input: { memberId: string; relatedMemberId: string }): Promise<void>
}

interface MemberRow {
  id: string
  display_name: string
  birth_month: string | null
  retirement_age: number
  monthly_contribution: number
  annual_income: number
  income_growth: number
  contribution_follows_raises: number
  social_security_monthly: number
  social_security_age: number
  pension_monthly: number
  pension_age: number
}

interface LinkRow {
  member_id: string
  related_member_id: string
  relationship: Relationship
}

const MEMBER_SELECT = `SELECT id, display_name, birth_month, retirement_age, monthly_contribution,
  annual_income, income_growth, contribution_follows_raises, social_security_monthly,
  social_security_age, pension_monthly, pension_age FROM members`

const linkId = (a: string, b: string) => (a < b ? `link-${a}:${b}` : `link-${b}:${a}`)

/**
 * Pure: who the retirement plan counts. It starts from the oldest profile with a birth month
 * and adds everyone linked to someone in the plan as a spouse or partner (and who has a birth
 * month, which the projection needs). Relatives, and people nobody in the plan is linked to,
 * keep their profile but stay out of the household's retirement figures.
 */
export function planStatuses(
  people: readonly { id: string; birthMonth: Month | null }[],
  links: readonly { memberId: string; relatedMemberId: string; relationship: Relationship }[],
): Map<string, PlanStatus> {
  const withBirth = new Set(people.filter((p) => p.birthMonth !== null).map((p) => p.id))
  const anchor = people.find((p) => p.birthMonth !== null)
  const included = new Set<string>()
  if (anchor) {
    included.add(anchor.id)
    const queue = [anchor.id]
    while (queue.length > 0) {
      const next = queue.shift()!
      for (const l of links) {
        if (!sharesFinances(l.relationship)) continue
        const other =
          l.memberId === next ? l.relatedMemberId : l.relatedMemberId === next ? l.memberId : null
        if (other && withBirth.has(other) && !included.has(other)) {
          included.add(other)
          queue.push(other)
        }
      }
    }
  }
  return new Map(
    people.map((p) => [
      p.id,
      included.has(p.id)
        ? { included: true, note: null }
        : {
            included: false,
            note: !withBirth.has(p.id)
              ? 'Needs a birth month to count in the retirement plan.'
              : 'Not linked as a spouse or partner of anyone in the retirement plan, so not counted.',
          },
    ]),
  )
}

/** Everyone in the household with their links, oldest first. */
export async function readProfiles(db: SqlRunner): Promise<Profile[]> {
  const rows = await db.query<MemberRow & Record<string, never>>(
    `${MEMBER_SELECT} ORDER BY created_at, id`,
  )
  const names = new Map(rows.map((r) => [r.id, r.display_name]))
  const linkRows = (
    await db.query<LinkRow & Record<string, never>>(
      `SELECT member_id, related_member_id, relationship FROM member_links
       WHERE relationship IS NOT NULL ORDER BY created_at, id`,
    )
  ).filter((l) => names.has(l.member_id) && names.has(l.related_member_id))
  const plan = planStatuses(
    rows.map((r) => ({ id: r.id, birthMonth: r.birth_month })),
    linkRows.map((l) => ({
      memberId: l.member_id,
      relatedMemberId: l.related_member_id,
      relationship: l.relationship,
    })),
  )
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    birthMonth: r.birth_month,
    retirementAge: r.retirement_age,
    monthlyContribution: r.monthly_contribution,
    annualIncome: r.annual_income,
    incomeGrowth: r.income_growth,
    contributionFollowsRaises: r.contribution_follows_raises === 1,
    socialSecurityMonthly: r.social_security_monthly,
    socialSecurityAge: r.social_security_age,
    pensionMonthly: r.pension_monthly,
    pensionAge: r.pension_age,
    links: linkRows.flatMap((l) =>
      l.member_id === r.id
        ? [
            {
              memberId: l.related_member_id,
              displayName: names.get(l.related_member_id)!,
              relationship: l.relationship,
            },
          ]
        : l.related_member_id === r.id
          ? [
              {
                memberId: l.member_id,
                displayName: names.get(l.member_id)!,
                relationship: l.relationship,
              },
            ]
          : [],
    ),
    plan: plan.get(r.id)!,
  }))
}

function assertInRange(value: number, range: { min: number; max: number }, what: string) {
  if (!Number.isInteger(value)) throw new Error(`${what} is a whole number of years`)
  if (value < range.min || value > range.max) {
    throw new Error(`${what} must be from ${range.min} to ${range.max}`)
  }
}

function assertCents(value: number, what: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what} is a whole number of cents, zero or more`)
  }
}

/** Throws for a value the database would refuse, with a message fit for the form. */
export function assertProfileSettings(s: ProfileSettings): void {
  if (s.birthMonth !== null) assertMonth(s.birthMonth)
  assertInRange(s.retirementAge, RETIREMENT_AGE_RANGE, 'The retirement age')
  assertCents(s.monthlyContribution, 'The contribution')
  assertCents(s.annualIncome, 'The income')
  if (
    !Number.isFinite(s.incomeGrowth) ||
    s.incomeGrowth < INCOME_GROWTH_RANGE.min ||
    s.incomeGrowth > INCOME_GROWTH_RANGE.max
  ) {
    throw new Error(
      `The yearly raise must be from ${INCOME_GROWTH_RANGE.min} to ${INCOME_GROWTH_RANGE.max}`,
    )
  }
  assertCents(s.socialSecurityMonthly, 'Social Security')
  assertInRange(s.socialSecurityAge, SOCIAL_SECURITY_AGE_RANGE, 'The Social Security age')
  assertCents(s.pensionMonthly, 'The pension')
  assertInRange(s.pensionAge, PENSION_AGE_RANGE, 'The pension age')
}

const columnsOf = (s: ProfileSettings) => ({
  birth_month: s.birthMonth,
  retirement_age: s.retirementAge,
  monthly_contribution: s.monthlyContribution,
  annual_income: s.annualIncome,
  income_growth: s.incomeGrowth,
  contribution_follows_raises: flag(s.contributionFollowsRaises),
  social_security_monthly: s.socialSecurityMonthly,
  social_security_age: s.socialSecurityAge,
  pension_monthly: s.pensionMonthly,
  pension_age: s.pensionAge,
})

const settingsOf = (p: ProfileSettings): ProfileSettings => ({
  birthMonth: p.birthMonth,
  retirementAge: p.retirementAge,
  monthlyContribution: p.monthlyContribution,
  annualIncome: p.annualIncome,
  incomeGrowth: p.incomeGrowth,
  contributionFollowsRaises: p.contributionFollowsRaises,
  socialSecurityMonthly: p.socialSecurityMonthly,
  socialSecurityAge: p.socialSecurityAge,
  pensionMonthly: p.pensionMonthly,
  pensionAge: p.pensionAge,
})

export function profilesApi({ adapter, newId, now, changes: log }: CrudDeps): ProfilesApi {
  async function getProfile(db: SqlRunner, id: string): Promise<Profile> {
    const profile = (await readProfiles(db)).find((p) => p.id === id)
    if (!profile) throw new Error('Person not found')
    return profile
  }

  async function assertNameFree(db: SqlRunner, name: string, exceptId?: string) {
    const rows = await db.query<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM members',
    )
    const taken = rows.some(
      (r) => r.id !== exceptId && r.display_name.toLowerCase() === name.toLowerCase(),
    )
    if (taken) throw new Error(`There is already someone named "${name}"`)
  }

  return {
    listProfiles: () => readProfiles(adapter),

    async createProfile({ displayName, ...given }) {
      const name = cleanName(displayName, 'Person')
      const settings = { ...DEFAULT_PROFILE_SETTINGS, ...given }
      assertProfileSettings(settings)
      const saved = { ...settings, incomeGrowth: Math.round(settings.incomeGrowth * 100) / 100 }
      return adapter.transaction(async (tx) => {
        const [household] = await tx.query<{ id: string }>(
          'SELECT id FROM households ORDER BY created_at, id LIMIT 1',
        )
        if (!household) throw new Error('Create the household first')
        await assertNameFree(tx, name)
        const id = newId()
        await log(tx).insert('members', {
          id,
          household_id: household.id,
          display_name: name,
          ...columnsOf(saved),
          created_at: now(),
        })
        return getProfile(tx, id)
      })
    },

    async updateProfile(id, { displayName, ...changes }) {
      return adapter.transaction(async (tx) => {
        const current = await getProfile(tx, id)
        const next = { ...settingsOf(current), ...changes }
        assertProfileSettings(next)
        const saved = { ...next, incomeGrowth: Math.round(next.incomeGrowth * 100) / 100 }
        const name = displayName === undefined ? undefined : cleanName(displayName, 'Person')
        if (name !== undefined) await assertNameFree(tx, name, id)
        await log(tx).update('members', id, {
          ...(name === undefined ? {} : { display_name: name }),
          ...columnsOf(saved),
        })
        return getProfile(tx, id)
      })
    },

    async deleteProfile(id) {
      await adapter.transaction(async (tx) => {
        await getProfile(tx, id)
        const [count] = await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM members')
        if ((count?.n ?? 0) <= 1) throw new Error('A household needs at least one person')
        const used = [
          ['a device', 'SELECT 1 AS x FROM devices WHERE member_id = ? LIMIT 1'],
          [
            'an investment account',
            'SELECT 1 AS x FROM investment_accounts WHERE owner_member_id = ? LIMIT 1',
          ],
          [
            'a contribution limit',
            'SELECT 1 AS x FROM contribution_limits WHERE member_id = ? LIMIT 1',
          ],
        ] as const
        for (const [what, sql] of used) {
          if ((await tx.query(sql, [id])).length > 0) {
            throw new Error(`This person is named by ${what}, so they can’t be removed`)
          }
        }
        // their links go with them; the id names both people, so it can never be wanted again
        for (const l of await tx.query<{ id: string }>(
          'SELECT id FROM member_links WHERE member_id = ? OR related_member_id = ?',
          [id, id],
        )) {
          await log(tx).delete('member_links', l.id)
        }
        await log(tx).delete('members', id)
      })
    },

    async linkProfiles({ memberId, relatedMemberId, relationship }) {
      if (!RELATIONSHIPS.includes(relationship)) throw new Error('Choose how they are related')
      if (memberId === relatedMemberId) throw new Error('A person can’t be linked to themselves')
      await adapter.transaction(async (tx) => {
        await getProfile(tx, memberId)
        await getProfile(tx, relatedMemberId)
        const id = linkId(memberId, relatedMemberId)
        const [stored] = await tx.query('SELECT 1 AS x FROM member_links WHERE id = ?', [id])
        if (stored) await log(tx).update('member_links', id, { relationship })
        else {
          const [low, high] =
            memberId < relatedMemberId ? [memberId, relatedMemberId] : [relatedMemberId, memberId]
          await log(tx).insert('member_links', {
            id,
            member_id: low,
            related_member_id: high,
            relationship,
            created_at: now(),
          })
        }
      })
    },

    async unlinkProfiles({ memberId, relatedMemberId }) {
      await adapter.transaction(async (tx) => {
        const id = linkId(memberId, relatedMemberId)
        const [stored] = await tx.query<{ relationship: string | null }>(
          'SELECT relationship FROM member_links WHERE id = ?',
          [id],
        )
        if (!stored || stored.relationship === null) throw new Error('They are not linked')
        // set to null, never deleted: a delete is permanent and they may be linked again
        await log(tx).update('member_links', id, { relationship: null })
      })
    },
  }
}
