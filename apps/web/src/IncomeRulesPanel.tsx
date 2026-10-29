import { cents, parseCents, type IncomeBasis, type IncomeRule } from '@budget-fi/core'
import { useState } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { money, monthLabel, monthOf, shiftMonth, shortDate, todayIso } from './format.ts'
import { describeIncomeRule } from './income-rule-text.ts'

const GOAL_PREFIX = 'goal:'

/** Rules that hand part of each paycheck to an envelope before anything else sees it. */
export function IncomeRulesPanel() {
  const refresh = useRefresh()
  const rules = useBudgetQuery(() => budget.listIncomeRules())
  const groups = useBudgetQuery(() => budget.listCategoryGroups())
  const goals = useBudgetQuery(() => budget.listGoals())
  const accounts = useBudgetQuery(() => budget.listAccounts())
  const [form, setForm] = useState({
    name: '',
    match: '',
    accountId: '',
    kind: 'percent' as 'percent' | 'fixed',
    value: '',
    basis: 'net' as IncomeBasis,
    target: '',
    priority: '',
  })
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch })

  const categoryNames = new Map(
    (groups.data ?? []).flatMap((g) => g.categories.map((c) => [c.id, c.name])),
  )
  const goalNames = new Map((goals.data ?? []).map((g) => [g.id, g.name]))
  const accountNames = new Map((accounts.data ?? []).map((a) => [a.id, a.name]))

  async function run(fn: () => Promise<void>) {
    setError(null)
    try {
      await fn()
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  function add() {
    return run(async () => {
      const goal = form.target.startsWith(GOAL_PREFIX)
        ? goals.data?.find((g) => g.id === form.target.slice(GOAL_PREFIX.length))
        : undefined
      const categoryId = goal ? goal.categoryId : form.target
      let percent: number | null = null
      let fixedAmount: number | null = null
      if (form.kind === 'percent') {
        percent = Number(form.value.replace('%', '').trim())
        if (form.value.trim() === '' || !Number.isFinite(percent)) {
          throw new Error('Enter the percent, like 10')
        }
      } else {
        fixedAmount = parseCents(form.value)
        if (fixedAmount === null) throw new Error('Enter the amount as dollars, like 50.00')
      }
      const priority = form.priority.trim() === '' ? undefined : Number(form.priority)
      await budget.createIncomeRule({
        name: form.name,
        match: form.match,
        accountId: form.accountId || null,
        basis: form.basis,
        percent,
        fixedAmount,
        categoryId,
        goalId: goal?.id ?? null,
        priority,
      })
      setForm({ ...form, name: '', match: '', value: '', priority: '' })
    })
  }

  const label = (r: IncomeRule) =>
    describeIncomeRule(r, {
      account: r.accountId ? (accountNames.get(r.accountId) ?? 'a removed account') : null,
      target: r.goalId
        ? `${categoryNames.get(r.categoryId) ?? 'a removed category'}: ${goalNames.get(r.goalId) ?? 'a removed goal'}`
        : (categoryNames.get(r.categoryId) ?? 'a removed category'),
      money: (n) => money(cents(n)),
    })

  return (
    <>
      <section className="card">
        <h2>Rules, in order</h2>
        <p className="muted">
          When income arrives in a budget account (typed in, or approved from the inbox), each
          matching rule assigns its share to an envelope, lowest priority number first. A rule never
          gives away more than the deposit, and whatever is left stays in Ready to Assign. If the
          income is later deleted or taken back, its shares are taken back too.
        </p>
        {rules.data?.length === 0 && <p className="muted">No rules yet.</p>}
        <ul className="plain">
          {rules.data?.map((r) => (
            <li key={r.id} className="row">
              <span>
                <strong>{r.name}</strong> <span className="muted">· priority {r.priority}</span>
                <br />
                {label(r)}
              </span>
              <button
                type="button"
                className="secondary danger"
                aria-label={`Delete the rule ${r.name}`}
                onClick={() => void run(() => budget.deleteIncomeRule(r.id))}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
        <p className="muted">
          Deleting or changing a rule leaves what it already assigned. Use “Check a month” below to
          bring a month in line.
        </p>
      </section>

      <section className="card">
        <h2>Add a rule</h2>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <label>
            Name
            <input
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Tithe"
            />
          </label>
          <label>
            Payee contains
            <input
              value={form.match}
              onChange={(e) => set({ match: e.target.value })}
              placeholder="Acme Payroll"
            />
          </label>
          <label>
            Account
            <select
              aria-label="Account the income lands in"
              value={form.accountId}
              onChange={(e) => set({ accountId: e.target.value })}
            >
              <option value="">Any budget account</option>
              {(accounts.data ?? [])
                .filter((a) => a.onBudget && !a.closed)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="row">
            <label>
              Give
              <select
                aria-label="Percent or fixed amount"
                value={form.kind}
                onChange={(e) => set({ kind: e.target.value as 'percent' | 'fixed' })}
              >
                <option value="percent">a percent</option>
                <option value="fixed">a fixed amount</option>
              </select>
            </label>
            <label>
              {form.kind === 'percent' ? 'Percent' : 'Amount'}
              <input
                inputMode="decimal"
                value={form.value}
                onChange={(e) => set({ value: e.target.value })}
                placeholder={form.kind === 'percent' ? '10' : '50.00'}
              />
            </label>
            {form.kind === 'percent' && (
              <label>
                Of
                <select
                  aria-label="Net or gross"
                  value={form.basis}
                  onChange={(e) => set({ basis: e.target.value as IncomeBasis })}
                >
                  <option value="net">the deposit (net)</option>
                  <option value="gross">gross pay</option>
                </select>
              </label>
            )}
          </div>
          {form.kind === 'percent' && form.basis === 'gross' && (
            <p className="muted">
              Type the gross pay on each paycheck when you enter or approve it; until then the rule
              gives nothing.
            </p>
          )}
          <label>
            Into
            <select
              aria-label="Envelope for the new rule"
              value={form.target}
              onChange={(e) => set({ target: e.target.value })}
            >
              <option value="">Choose…</option>
              {(groups.data ?? [])
                .filter((g) => !g.hidden)
                .map((g) => (
                  <optgroup key={g.id} label={g.name}>
                    {g.categories
                      .filter((c) => !c.hidden && !c.creditCardAccountId)
                      .flatMap((c) => [
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>,
                        ...(goals.data ?? [])
                          .filter((goal) => goal.categoryId === c.id && !goal.archived)
                          .map((goal) => (
                            <option key={goal.id} value={`${GOAL_PREFIX}${goal.id}`}>
                              {`  ↳ ${goal.name}`}
                            </option>
                          )),
                      ])}
                  </optgroup>
                ))}
            </select>
          </label>
          <label>
            Priority <span className="muted">(1 runs first; blank goes last)</span>
            <input
              inputMode="numeric"
              value={form.priority}
              onChange={(e) => set({ priority: e.target.value })}
            />
          </label>
          <div className="row">
            <button
              type="submit"
              disabled={
                !form.name.trim() ||
                (!form.match.trim() && !form.accountId) ||
                !form.value.trim() ||
                !form.target
              }
            >
              Add rule
            </button>
          </div>
        </form>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>

      <MonthCheck />
    </>
  )
}

/** What the rules give each paycheck of a month beside what the budget holds. */
function MonthCheck() {
  const refresh = useRefresh()
  const [month, setMonth] = useState(() => monthOf(todayIso()))
  const report = useBudgetQuery(() => budget.getIncomeRulesReport(month), [month])
  const groups = useBudgetQuery(() => budget.listCategoryGroups())
  const goals = useBudgetQuery(() => budget.listGoals())
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { name, year } = monthLabel(month)
  const data = report.data

  const names = new Map((groups.data ?? []).flatMap((g) => g.categories.map((c) => [c.id, c.name])))
  const goalNames = new Map((goals.data ?? []).map((g) => [g.id, g.name]))
  const targetName = (categoryId: string, goalId: string | null) =>
    `${names.get(categoryId) ?? 'a removed category'}${goalId ? `: ${goalNames.get(goalId) ?? 'a goal'}` : ''}`
  const unsettled = data?.deposits.some((d) => !d.settled) ?? false

  async function apply() {
    setError(null)
    setNote(null)
    try {
      const done = await budget.applyIncomeRules(month)
      setNote(
        done.allocations === 0
          ? 'Nothing needed changing.'
          : `Made ${done.allocations} ${done.allocations === 1 ? 'entry' : 'entries'} for ${done.deposits} ${done.deposits === 1 ? 'deposit' : 'deposits'}.`,
      )
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <section className="card" aria-label="Check a month">
      <h2>Check a month</h2>
      <p className="muted">
        Compares what your rules give each paycheck with what is in the ledger. Check a month you
        have already budgeted to see whether the rules would have produced the same numbers.
      </p>
      <div className="month-nav">
        <button
          type="button"
          className="icon-button"
          aria-label="Previous month"
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          ‹
        </button>
        <span className="report-month">
          {name} <span className="muted">{year}</span>
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="Next month"
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          ›
        </button>
      </div>
      {report.error && (
        <p className="error" role="alert">
          {report.error.message}
        </p>
      )}
      {data && data.deposits.length === 0 && <p className="muted">No income this month.</p>}
      {data && data.deposits.length > 0 && (
        <div className="table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th scope="col">Deposit</th>
                <th scope="col">Rule</th>
                <th scope="col" className="num">
                  Rules give
                </th>
                <th scope="col" className="num">
                  In ledger
                </th>
              </tr>
            </thead>
            <tbody>
              {data.deposits.map((d) => (
                <DepositRows key={d.transactionId} deposit={d} targetName={targetName} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.targets.length > 0 && (
        <>
          <h3>Envelopes this month</h3>
          <div className="table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th scope="col">Envelope</th>
                  <th scope="col" className="num">
                    Rules give
                  </th>
                  <th scope="col" className="num">
                    Assigned by rules
                  </th>
                  <th scope="col" className="num">
                    Assigned in all
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.targets.map((t) => (
                  <tr key={`${t.categoryId}:${t.goalId ?? ''}`}>
                    <th scope="row">{targetName(t.categoryId, t.goalId)}</th>
                    <td className="num">{money(t.expected)}</td>
                    <td className="num">{money(t.fromRules)}</td>
                    <td className="num">{money(t.assigned)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {unsettled && (
        <div className="row">
          <button type="button" onClick={() => void apply()}>
            Apply the rules to {name}
          </button>
          <span className="muted">
            Adds entries for what is missing. Money you already assigned by hand is not counted, so
            apply only to months you haven’t budgeted that way.
          </span>
        </div>
      )}
      {note && <p role="status">{note}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function DepositRows(props: {
  deposit: Awaited<ReturnType<typeof budget.getIncomeRulesReport>>['deposits'][number]
  targetName: (categoryId: string, goalId: string | null) => string
}) {
  const d = props.deposit
  const heading = (
    <tr>
      <th scope="row" colSpan={2}>
        {shortDate(d.date)} · {d.payee ?? 'Deposit'} · {money(d.amount)}
        {d.gross !== null && <span className="muted"> (gross {money(d.gross)})</span>}
        {d.reversed > 0 && <span className="muted"> · {money(d.reversed)} taken back</span>}
      </th>
      <td className="num">{d.remainder !== 0 && `${money(d.remainder)} stays`}</td>
      <td className="num">{d.settled ? '✓' : ''}</td>
    </tr>
  )
  return (
    <>
      {heading}
      {d.lines.map((l) => (
        <tr key={l.ruleId}>
          <td />
          <td>
            {l.ruleName} <span className="muted">→ {props.targetName(l.categoryId, l.goalId)}</span>
            {l.needsGross && <span className="muted"> · needs gross pay</span>}
          </td>
          <td className="num">{money(l.expected)}</td>
          <td className="num">{money(l.assigned)}</td>
        </tr>
      ))}
      {d.lines.length === 0 && (
        <tr>
          <td />
          <td className="muted" colSpan={3}>
            No rule matches
          </td>
        </tr>
      )}
    </>
  )
}
