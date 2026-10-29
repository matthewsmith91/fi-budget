import { FORECAST_DAYS, type RecurringItem } from '@budget-fi/core'
import { LineChart } from '@budget-fi/ui'
import { useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import {
  money,
  moneyShort,
  monthLabel,
  monthOf,
  shiftMonth,
  shortDate,
  todayIso,
} from './format.ts'
import {
  CADENCE_LABELS,
  dayLabel,
  dayShort,
  emptyRecurringForm,
  monthGrid,
  parseRecurringForm,
  recurringFormOf,
  type RecurringForm,
} from './planning-text.ts'

const HORIZONS = [30, 45, 60, 90] as const
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Bills and paychecks on a schedule, the month they fall in, and where cash is heading. */
export function BillsView({ today }: { today: Date }) {
  const todayDate = todayIso(today)
  return (
    <div className="page">
      <header className="page-header">
        <h1>Bills &amp; forecast</h1>
      </header>
      <ForecastCard from={todayDate} />
      <CalendarCard today={todayDate} />
      <ItemsCard today={todayDate} />
    </div>
  )
}

function ForecastCard({ from }: { from: string }) {
  const [days, setDays] = useState<number>(FORECAST_DAYS.default)
  const forecast = useBudgetQuery(() => budget.getCashFlowForecast({ from, days }), [from, days])
  const f = forecast.data
  const busy = f?.days.filter((d) => d.events.length > 0) ?? []

  return (
    <section className="card" aria-label="Cash-flow forecast">
      <header className="card-header">
        <h2>Cash-flow forecast</h2>
        <label className="inline-field">
          Look ahead
          <select
            aria-label="Forecast length"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {HORIZONS.map((n) => (
              <option key={n} value={n}>
                {n} days
              </option>
            ))}
          </select>
        </label>
      </header>

      {f && (
        <>
          {f.firstNegative !== null ? (
            <p className="warn" role="status">
              <strong>Cash runs out.</strong> The balance goes below zero on{' '}
              {dayLabel(f.firstNegative)} and bottoms out at {money(f.lowest.balance)} on{' '}
              {dayLabel(f.lowest.date)}.
            </p>
          ) : (
            <p role="status">
              Cash stays above zero for the next {days} days. The lowest point is{' '}
              <strong>{money(f.lowest.balance)}</strong> on {dayLabel(f.lowest.date)}.
            </p>
          )}
          <dl className="fund-figures">
            <dt>Cash today</dt>
            <dd>{money(f.startBalance)}</dd>
            <dt>Bills due</dt>
            <dd>{money(f.outflow)}</dd>
            <dt>Money expected</dt>
            <dd>{money(f.inflow)}</dd>
            <dt>In {days} days</dt>
            <dd className={f.endBalance < 0 ? 'negative' : undefined}>{money(f.endBalance)}</dd>
          </dl>
          <LineChart
            ariaLabel={`Projected cash from ${dayLabel(f.days[0]!.date)} to ${dayLabel(f.days[f.days.length - 1]!.date)}`}
            labels={f.days.map((d) => dayShort(d.date))}
            detailLabels={f.days.map((d) => dayLabel(d.date))}
            series={[
              {
                label: 'Cash',
                values: f.days.map((d) => d.balance),
                color: 'var(--series-1)',
              },
            ]}
            formatValue={money}
            formatTick={moneyShort}
          />
          {busy.length > 0 && (
            <details>
              <summary>Show the days with something due</summary>
              <div className="table-wrap">
                <table className="report-table">
                  <thead>
                    <tr>
                      <th scope="col">Day</th>
                      <th scope="col">What</th>
                      <th scope="col" className="num">
                        Amount
                      </th>
                      <th scope="col" className="num">
                        Cash after
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {busy.map((d) => (
                      <tr key={d.date}>
                        <th scope="row">{dayLabel(d.date)}</th>
                        <td>
                          {d.events
                            .map((e) => e.payee + (e.overdue ? ' (past due)' : ''))
                            .join(', ')}
                        </td>
                        <td className="num">{money(d.events.reduce((n, e) => n + e.amount, 0))}</td>
                        <td className={d.balance < 0 ? 'num negative' : 'num'}>
                          {money(d.balance)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {f.accounts.length === 0 && (
            <p className="warn" role="status">
              There is no checking or savings account in the budget, so there is no cash to forecast
              from.
            </p>
          )}
          <p className="muted">
            Starts from{' '}
            {f.accounts.map((a) => `${a.name} (${money(a.balance)})`).join(', ') || 'no accounts'},
            the budget’s checking and savings. A bill that is past due counts once, today. A bill on
            a credit card counts the day it is charged, as if paid at once.
          </p>
        </>
      )}
      {forecast.error && (
        <p className="error" role="alert">
          {forecast.error.message}
        </p>
      )}
    </section>
  )
}

function CalendarCard({ today }: { today: string }) {
  const [month, setMonth] = useState(() => monthOf(today))
  const calendar = useBudgetQuery(() => budget.getBillsCalendar({ month }), [month])
  const label = monthLabel(month)
  const byDay = new Map((calendar.data?.days ?? []).map((d) => [d.date, d.items]))

  return (
    <section className="card" aria-label="Bills calendar">
      <header className="card-header">
        <h2>Bills calendar</h2>
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
            {label.name} <span className="muted">{label.year}</span>
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
      </header>
      {calendar.data && (
        <p className="muted">
          {money(calendar.data.due)} in bills due
          {calendar.data.expected > 0 ? `, ${money(calendar.data.expected)} expected` : ''}.
        </p>
      )}
      <div className="calendar" role="grid" aria-label={`${label.name} ${label.year}`}>
        {WEEKDAYS.map((d) => (
          <div key={d} className="calendar-weekday" role="columnheader">
            {d}
          </div>
        ))}
        {monthGrid(month).map((date, i) => {
          const items = date ? (byDay.get(date) ?? []) : []
          const classes = ['calendar-day']
          if (!date) classes.push('blank')
          else if (items.length === 0) classes.push('quiet')
          if (date === today) classes.push('today')
          return (
            <div key={date ?? `blank-${i}`} className={classes.join(' ')} role="gridcell">
              {date && (
                <>
                  <span className="calendar-date">{Number(date.slice(8, 10))}</span>
                  {items.map((item) => (
                    <span
                      key={item.recurringId}
                      className={item.amount < 0 ? 'calendar-item' : 'calendar-item income'}
                      title={`${item.payee}: ${money(item.amount)}${date < today ? ' (past due)' : ''}`}
                    >
                      {item.payee} {money(item.amount)}
                      {date < today && <span className="negative"> past due</span>}
                    </span>
                  ))}
                </>
              )}
            </div>
          )
        })}
      </div>
      {calendar.data && calendar.data.days.length === 0 && (
        <p className="muted">Nothing is due this month.</p>
      )}
      {calendar.error && (
        <p className="error" role="alert">
          {calendar.error.message}
        </p>
      )}
    </section>
  )
}

function ItemsCard({ today }: { today: string }) {
  const refresh = useRefresh()
  const items = useBudgetQuery(() => budget.listRecurring())
  const accounts = useBudgetQuery(() => budget.listAccounts())
  const groups = useBudgetQuery(() => budget.listCategoryGroups())
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<RecurringForm>(emptyRecurringForm)
  const [error, setError] = useState<string | null>(null)

  const categories = (groups.data ?? [])
    .map((g) => ({
      ...g,
      categories: g.categories.filter((c) => !c.creditCardAccountId && !c.hidden),
    }))
    .filter((g) => g.categories.length > 0)
  const categoryName = new Map(
    (groups.data ?? []).flatMap((g) => g.categories).map((c) => [c.id, c.name]),
  )
  const live = (accounts.data ?? []).filter((a) => !a.closed)
  const accountName = new Map((accounts.data ?? []).map((a) => [a.id, a.name]))

  async function run(action: () => Promise<unknown>) {
    setError(null)
    try {
      await action()
      refresh()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const parsed = parseRecurringForm(form)
    if (!parsed.ok) return setError(parsed.error)
    await run(async () => {
      if (editing) await budget.updateRecurring(editing, parsed.input)
      else await budget.createRecurring(parsed.input)
      setEditing(null)
      setForm(emptyRecurringForm)
    })
  }

  const set = (patch: Partial<RecurringForm>) => setForm({ ...form, ...patch })

  function edit(item: RecurringItem) {
    setEditing(item.id)
    setForm(recurringFormOf(item))
    setError(null)
  }

  return (
    <section className="card" aria-label="Recurring bills and income">
      <h2>Recurring bills and income</h2>
      {items.data && items.data.length === 0 && (
        <p className="muted">
          Add the rent, the subscriptions and the paychecks that come round on a schedule. They feed
          the calendar and the forecast.
        </p>
      )}
      {items.data && items.data.length > 0 && (
        <div className="table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th scope="col">Payee</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col">Repeats</th>
                <th scope="col">Next due</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.data.map((item) => {
                const where = [
                  item.categoryId && categoryName.get(item.categoryId),
                  item.accountId && accountName.get(item.accountId),
                ].filter(Boolean)
                return (
                  <tr key={item.id}>
                    <th scope="row">
                      {item.payee}
                      {where.length > 0 && <small className="muted"> {where.join(' · ')}</small>}
                    </th>
                    <td className="num">{money(item.amount)}</td>
                    <td>{CADENCE_LABELS[item.cadence]}</td>
                    <td>
                      {shortDate(item.nextDate)}
                      {item.nextDate < today && <span className="negative"> past due</span>}
                    </td>
                    <td>
                      <span className="row">
                        <button
                          type="button"
                          title="Moves to the next due date. Enter the transaction in its account too."
                          aria-label={`Mark ${item.payee} paid`}
                          onClick={() => void run(() => budget.advanceRecurring(item.id))}
                        >
                          Mark paid
                        </button>
                        <button
                          type="button"
                          onClick={() => edit(item)}
                          aria-label={`Edit ${item.payee}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${item.payee}`}
                          onClick={() => void run(() => budget.deleteRecurring(item.id))}
                        >
                          Delete
                        </button>
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <form
        className="inline wrap"
        noValidate
        aria-label={editing ? 'Edit recurring item' : 'Add a recurring item'}
        onSubmit={(e) => void save(e)}
      >
        <label>
          Payee
          <input
            aria-label="Recurring payee"
            placeholder="Landlord"
            value={form.payee}
            onChange={(e) => set({ payee: e.target.value })}
          />
        </label>
        <label>
          Kind
          <select
            aria-label="Recurring kind"
            value={form.kind}
            onChange={(e) => set({ kind: e.target.value as RecurringForm['kind'] })}
          >
            <option value="bill">Bill</option>
            <option value="income">Income</option>
          </select>
        </label>
        <label>
          Amount
          <input
            inputMode="decimal"
            aria-label="Recurring amount"
            placeholder="0.00"
            value={form.amount}
            onChange={(e) => set({ amount: e.target.value })}
          />
        </label>
        <label>
          Repeats
          <select
            aria-label="Recurring cadence"
            value={form.cadence}
            onChange={(e) => set({ cadence: e.target.value as RecurringForm['cadence'] })}
          >
            {Object.entries(CADENCE_LABELS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <label>
          Next due
          <input
            type="date"
            aria-label="Recurring next due"
            value={form.nextDate}
            onChange={(e) => set({ nextDate: e.target.value })}
          />
        </label>
        <label>
          Category
          <select
            aria-label="Recurring category"
            value={form.categoryId}
            onChange={(e) => set({ categoryId: e.target.value })}
          >
            <option value="">None</option>
            {categories.map((g) => (
              <optgroup key={g.id} label={g.name}>
                {g.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          Account
          <select
            aria-label="Recurring account"
            value={form.accountId}
            onChange={(e) => set({ accountId: e.target.value })}
          >
            <option value="">Any</option>
            {live.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">{editing ? 'Save item' : 'Add item'}</button>
        {editing && (
          <button
            type="button"
            onClick={() => {
              setEditing(null)
              setForm(emptyRecurringForm)
              setError(null)
            }}
          >
            Cancel
          </button>
        )}
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="muted">
        An item stays due until you mark it paid, which moves it to its next date, so mark it paid
        once its transaction is entered; otherwise the forecast counts it twice. A category gives
        the bill its need or want tag.
      </p>
    </section>
  )
}
