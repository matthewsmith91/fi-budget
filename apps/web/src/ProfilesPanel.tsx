import {
  INCOME_GROWTH_RANGE,
  PENSION_AGE_RANGE,
  RELATIONSHIPS,
  RELATIONSHIP_LABELS,
  RETIREMENT_AGE_RANGE,
  SOCIAL_SECURITY_AGE_RANGE,
  type Profile,
  type Relationship,
} from '@budget-fi/core'
import { useEffect, useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { money } from './format.ts'
import { parseProfileForm, profileFormOf, savingsRate, type ProfileForm } from './profile-text.ts'
import { useConfirm } from './use-confirm.tsx'

/**
 * Everyone in the household: the facts the retirement plan needs about each person, and how they
 * are related. Spouses and partners are planned together; relatives are only recorded.
 */
export function ProfilesPanel() {
  const profiles = useBudgetQuery(() => budget.listProfiles())
  const { ask, dialog } = useConfirm()
  const people = profiles.data ?? []
  return (
    <>
      {profiles.error && (
        <p className="error" role="alert">
          {profiles.error.message}
        </p>
      )}
      {people.map((p) => (
        <ProfileCard key={p.id} profile={p} people={people} ask={ask} />
      ))}
      <AddPerson />
      <p className="muted">
        The retirement plan on the Reports page counts the first person with a birth month and
        everyone linked to them as a spouse or partner. It adds up their contributions (each stops
        when that person retires), their Social Security and pensions, and takes the date from
        whoever retires last. Everything is in today’s dollars.
      </p>
      {dialog}
    </>
  )
}

type Ask = ReturnType<typeof useConfirm>['ask']

function ProfileCard(props: { profile: Profile; people: Profile[]; ask: Ask }) {
  const { profile, people, ask } = props
  const refresh = useRefresh()
  const [form, setForm] = useState<ProfileForm>(() => profileFormOf(profile))
  // what the form edits changed in the budget (a save, a sync from another device): show it
  const savedForm = JSON.stringify(profileFormOf(profile))
  useEffect(() => setForm(JSON.parse(savedForm) as ProfileForm), [savedForm])
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const set = (patch: Partial<ProfileForm>) => {
    setSaved(false)
    setForm({ ...form, ...patch })
  }

  async function run(fn: () => Promise<void>) {
    setError(null)
    try {
      await fn()
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSaved(false)
    const parsed = parseProfileForm(form)
    if (!parsed.ok) return setError(parsed.error)
    await run(async () => {
      await budget.updateProfile(profile.id, parsed.input)
      setSaved(true)
    })
  }

  async function remove() {
    const ok = await ask({
      title: `Remove ${profile.displayName}?`,
      message: 'Their profile and its links are deleted. This can’t be undone.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (ok) await run(() => budget.deleteProfile(profile.id))
  }

  const rate = savingsRate(profile.monthlyContribution, profile.annualIncome)
  const linkable = people.filter(
    (o) => o.id !== profile.id && !profile.links.some((l) => l.memberId === o.id),
  )

  return (
    <section className="card" aria-label={`Profile: ${profile.displayName}`}>
      <h2>{profile.displayName}</h2>
      <p className={profile.plan.included ? 'muted' : 'warn'} role="status">
        {profile.plan.included
          ? 'Counted in the retirement plan.'
          : (profile.plan.note ?? 'Not counted in the retirement plan.')}
      </p>

      <form
        className="stack stretch"
        noValidate
        aria-label={`${profile.displayName}’s details`}
        onSubmit={(e) => void save(e)}
      >
        <div className="fields">
          <label>
            Name
            <input
              aria-label="Name"
              value={form.displayName}
              onChange={(e) => set({ displayName: e.target.value })}
            />
          </label>
          <label>
            Born
            <input
              type="month"
              aria-label="Birth month"
              value={form.birthMonth}
              onChange={(e) => set({ birthMonth: e.target.value })}
            />
          </label>
          <label>
            Retire at
            <input
              type="number"
              aria-label="Retirement age"
              min={RETIREMENT_AGE_RANGE.min}
              max={RETIREMENT_AGE_RANGE.max}
              step={1}
              value={form.retirementAge}
              onChange={(e) => set({ retirementAge: e.target.value })}
            />
          </label>
        </div>

        <fieldset className="fields">
          <legend>Income and saving</legend>
          <label>
            Income a year (before tax)
            <input
              inputMode="decimal"
              aria-label="Yearly income"
              placeholder="0.00"
              value={form.annualIncome}
              onChange={(e) => set({ annualIncome: e.target.value })}
            />
          </label>
          <label>
            Usual raise a year (%)
            <input
              type="number"
              aria-label="Yearly raise"
              min={INCOME_GROWTH_RANGE.min}
              max={INCOME_GROWTH_RANGE.max}
              step="any"
              value={form.incomeGrowth}
              onChange={(e) => set({ incomeGrowth: e.target.value })}
            />
          </label>
          <label>
            Into retirement accounts a month
            <input
              inputMode="decimal"
              aria-label="Monthly contribution"
              placeholder="0.00"
              value={form.monthlyContribution}
              onChange={(e) => set({ monthlyContribution: e.target.value })}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={form.contributionFollowsRaises}
              onChange={(e) => set({ contributionFollowsRaises: e.target.checked })}
            />{' '}
            Contribution grows with raises that beat inflation
          </label>
        </fieldset>
        {rate !== null && (
          <p className="muted">
            Saving {money(profile.monthlyContribution * 12)} a year is {rate}% of income.
          </p>
        )}

        <fieldset className="fields">
          <legend>In retirement</legend>
          <label>
            Social Security a month
            <input
              inputMode="decimal"
              aria-label="Social Security a month"
              placeholder="0.00"
              value={form.socialSecurityMonthly}
              onChange={(e) => set({ socialSecurityMonthly: e.target.value })}
            />
          </label>
          <label>
            Claimed at
            <input
              type="number"
              aria-label="Social Security age"
              min={SOCIAL_SECURITY_AGE_RANGE.min}
              max={SOCIAL_SECURITY_AGE_RANGE.max}
              step={1}
              value={form.socialSecurityAge}
              onChange={(e) => set({ socialSecurityAge: e.target.value })}
            />
          </label>
          <label>
            Pension a month
            <input
              inputMode="decimal"
              aria-label="Pension a month"
              placeholder="0.00"
              value={form.pensionMonthly}
              onChange={(e) => set({ pensionMonthly: e.target.value })}
            />
          </label>
          <label>
            Starts at
            <input
              type="number"
              aria-label="Pension age"
              min={PENSION_AGE_RANGE.min}
              max={PENSION_AGE_RANGE.max}
              step={1}
              value={form.pensionAge}
              onChange={(e) => set({ pensionAge: e.target.value })}
            />
          </label>
        </fieldset>

        <div className="row">
          <button type="submit">Save</button>
          {people.length > 1 && (
            <button type="button" onClick={() => void remove()}>
              Remove {profile.displayName}
            </button>
          )}
        </div>
      </form>
      {saved && <p role="status">Saved.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <h3>Family</h3>
      {profile.links.length === 0 && (
        <p className="muted">
          Not linked to anyone. Link a spouse or partner to plan retirement together.
        </p>
      )}
      {profile.links.length > 0 && (
        <ul className="plain stack stretch">
          {profile.links.map((l) => (
            <li key={l.memberId} className="row spread">
              <span>
                {RELATIONSHIP_LABELS[l.relationship]}: {l.displayName}
              </span>
              <button
                type="button"
                aria-label={`Unlink ${l.displayName} from ${profile.displayName}`}
                onClick={() =>
                  void run(() =>
                    budget.unlinkProfiles({
                      memberId: profile.id,
                      relatedMemberId: l.memberId,
                    }),
                  )
                }
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}
      {linkable.length > 0 && <AddLink profile={profile} others={linkable} run={run} />}
    </section>
  )
}

function AddLink(props: {
  profile: Profile
  others: Profile[]
  run: (fn: () => Promise<void>) => Promise<void>
}) {
  const { profile, others, run } = props
  const [otherId, setOtherId] = useState('')
  const [relationship, setRelationship] = useState<Relationship>('spouse')
  const chosen = otherId || others[0]!.id
  return (
    <form
      className="inline wrap"
      aria-label={`Link ${profile.displayName}`}
      onSubmit={(e) => {
        e.preventDefault()
        void run(() =>
          budget.linkProfiles({
            memberId: profile.id,
            relatedMemberId: chosen,
            relationship,
          }),
        )
      }}
    >
      <label>
        Link to
        <select
          aria-label={`Link ${profile.displayName} to`}
          value={chosen}
          onChange={(e) => setOtherId(e.target.value)}
        >
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        As
        <select
          aria-label="Relationship"
          value={relationship}
          onChange={(e) => setRelationship(e.target.value as Relationship)}
        >
          {RELATIONSHIPS.map((r) => (
            <option key={r} value={r}>
              {RELATIONSHIP_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
      <button type="submit">Link</button>
    </form>
  )
}

function AddPerson() {
  const refresh = useRefresh()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function add(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await budget.createProfile({ displayName: name })
      setName('')
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <section className="card" aria-label="Add a person">
      <h2>Add a person</h2>
      <p className="muted">
        Add someone who uses this budget. Fill in their details once they are added.
      </p>
      <form className="inline" onSubmit={(e) => void add(e)}>
        <label>
          Name
          <input
            aria-label="New person’s name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button type="submit">Add person</button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
