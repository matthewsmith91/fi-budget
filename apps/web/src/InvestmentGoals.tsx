import { parseCents, type AccountInvestments, type GoalInvestment } from '@budget-fi/core'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { budget } from './client.ts'
import { useBudgetQuery, useRefresh } from './data.ts'
import { messageOf } from './errors.ts'
import { money, parseDate, shortDate, todayIso } from './format.ts'
import { gainText, parsePrice, parseShares, priceText, unitsText } from './investment-text.ts'

const UNASSIGNED = ''

/**
 * A button for what each goal owns of an investment account: value, cost basis, gain or
 * loss and realized gains, with the entries that move units or record trades. It opens in
 * a dialog so it can be wide enough for the table.
 */
export function InvestmentGoals({ accountId }: { accountId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        Goals
      </button>
      {open && <GoalsDialog accountId={accountId} onClose={() => setOpen(false)} />}
    </>
  )
}

const nameOf = (g: GoalInvestment) => g.goalName ?? 'Unassigned'

/** Mounted only while shown, so it starts fresh every time. */
function GoalsDialog({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const refresh = useRefresh()
  const accounts = useBudgetQuery(() => budget.listInvestmentAccounts())
  const figures = useBudgetQuery(() => budget.getAccountInvestments(accountId), [accountId])
  const events = useBudgetQuery(() => budget.listUnitEvents(accountId), [accountId])
  const goals = useBudgetQuery(() => budget.listGoals())
  const [error, setError] = useState<string | null>(null)
  useEffect(() => dialog.current?.showModal(), [])

  const account = accounts.data?.find((a) => a.accountId === accountId)
  const data = figures.data
  const openGoals = (goals.data ?? []).filter((g) => !g.archived)
  const goalName = new Map((goals.data ?? []).map((g) => [g.id, g.name] as const))

  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setError(null)
    try {
      await fn()
      refresh()
      return true
    } catch (err) {
      setError(messageOf(err))
      return false
    }
  }

  return (
    <dialog
      ref={dialog}
      className="dialog tall wide"
      aria-labelledby="goals-title"
      onClose={onClose}
    >
      <div className="stack stretch">
        <h2 id="goals-title">{account?.name ?? 'Account'}: what goals own</h2>
        {data && <Summary data={data} />}
        {data && data.goals.length > 0 ? (
          <GoalTable data={data} />
        ) : (
          data && (
            <p className="muted">
              Nothing is owned by a goal yet. A cleared transfer into this account buys units for
              the goal chosen on the transfer, and a cleared transfer out sells them.
              {account?.latestValuation
                ? ''
                : ' Record the account’s value first, dated before your first transfer, so what it already holds starts as Unassigned.'}
            </p>
          )
        )}
        {data?.mode === 'units' && (
          <MoveForm
            accountId={accountId}
            data={data}
            options={openGoals.map((g) => ({ id: g.id, name: g.name }))}
            run={run}
          />
        )}
        {data && (
          <HoldingsSection
            accountId={accountId}
            data={data}
            options={openGoals.map((g) => ({ id: g.id, name: g.name }))}
            run={run}
          />
        )}
        {events.data && events.data.length > 0 && (
          <section className="stack stretch">
            <h3>History</h3>
            <ul className="plain">
              {events.data.slice(0, 40).map((e) => (
                <li key={e.id} className="row spread">
                  <span>
                    {shortDate(e.date)} · {EVENT_LABELS[e.type]}{' '}
                    {e.holdingId ? '' : (goalName.get(e.goalId ?? '') ?? 'Unassigned')} ·{' '}
                    {money(e.amount)}{' '}
                    <span className="muted">
                      {unitsText(e.units)} at {priceText(e.unitPrice)}
                      {e.source === 'transaction' ? ', from a transaction' : ''}
                      {e.source === 'opening' ? ', the account’s starting value' : ''}
                    </span>
                  </span>
                  {e.source === 'manual' && (
                    <button
                      type="button"
                      className="secondary danger"
                      aria-label={`Delete the ${EVENT_LABELS[e.type].toLowerCase()} from ${shortDate(e.date)}`}
                      onClick={() => void run(() => budget.deleteUnitEntry(e.id))}
                    >
                      Delete
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="row">
          <button
            type="button"
            className="secondary"
            onClick={() => void run(() => budget.rebuildUnitLedger(accountId))}
          >
            Build from past transfers
          </button>
        </div>
        <small className="muted">
          Use this for transfers entered before goals owned units. Clearing a transfer later does
          the same on its own.
        </small>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  )
}

const EVENT_LABELS = {
  buy: 'Bought',
  sell: 'Sold',
  dividend: 'Dividend',
  move_in: 'Moved in to',
  move_out: 'Moved out of',
} as const

const signClass = (n: number) => (n < 0 ? 'negative' : '')

function Summary({ data }: { data: AccountInvestments }) {
  return (
    <p>
      <strong>{money(data.value)}</strong> owned by goals, cost {money(data.costBasis)},{' '}
      <span className={signClass(data.gain)}>{gainText(data.gain)}</span>
      {data.realized !== 0 && <>, {gainText(data.realized)} realized</>}
      {data.unitPrice !== null && (
        <span className="muted">
          {' '}
          · {priceText(data.unitPrice)} a unit
          {data.priceDate ? ` from the ${shortDate(data.priceDate)} value` : ''}
        </span>
      )}
      {data.accountValue !== null && Math.abs(data.accountValue - data.value) > 0 && (
        <span className="muted"> · account value on file {money(data.accountValue)}</span>
      )}
    </p>
  )
}

function GoalTable({ data }: { data: AccountInvestments }) {
  return (
    <div className="table-wrap">
      <table className="report-table">
        <thead>
          <tr>
            <th scope="col">Goal</th>
            <th scope="col" className="num">
              Value
            </th>
            <th scope="col" className="num">
              Cost basis
            </th>
            <th scope="col" className="num">
              Gain / loss
            </th>
            <th scope="col" className="num">
              Realized
            </th>
          </tr>
        </thead>
        <tbody>
          {data.goals.map((g) => (
            <GoalRowSet key={g.goalId ?? 'unassigned'} goal={g} />
          ))}
          <tr>
            <th scope="row">Total</th>
            <td className="num">{money(data.value)}</td>
            <td className="num">{money(data.costBasis)}</td>
            <td className={`num ${signClass(data.gain)}`}>{gainText(data.gain)}</td>
            <td className="num">{gainText(data.realized)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function GoalRowSet({ goal }: { goal: GoalInvestment }) {
  return (
    <>
      <tr>
        <th scope="row">
          {nameOf(goal)}
          {goal.units > 0 && <span className="muted"> · {unitsText(goal.units)} units</span>}
        </th>
        <td className="num">{money(goal.value)}</td>
        <td className="num">{money(goal.costBasis)}</td>
        <td className={`num ${signClass(goal.gain)}`}>{gainText(goal.gain)}</td>
        <td className="num">{gainText(goal.realized)}</td>
      </tr>
      {goal.holdings.map((h) => (
        <tr key={h.id} className="sub-row">
          <th scope="row">
            {'  ↳ '}
            {h.name}
            <span className="muted">
              {' '}
              · {unitsText(h.shares)} shares
              {h.price === null ? ', no price yet' : ` at ${priceText(h.price)}`}
            </span>
          </th>
          <td className="num">{money(h.value)}</td>
          <td className="num">{money(h.costBasis)}</td>
          <td className={`num ${signClass(h.gain)}`}>{gainText(h.gain)}</td>
          <td className="num">{gainText(h.realized)}</td>
        </tr>
      ))}
    </>
  )
}

type Option = { id: string; name: string }
type Run = (fn: () => Promise<unknown>) => Promise<boolean>

function GoalSelect(props: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Option[]
}) {
  return (
    <label>
      {props.label}
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        <option value={UNASSIGNED}>Unassigned</option>
        {props.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  )
}

function MoveForm(props: {
  accountId: string
  data: AccountInvestments
  options: Option[]
  run: Run
}) {
  const [from, setFrom] = useState(UNASSIGNED)
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(() => shortDate(todayIso()))
  const [problem, setProblem] = useState<string | null>(null)
  // Only goals that already own something can give any of it up.
  const owners = new Set(props.data.goals.filter((g) => g.units > 0).map((g) => g.goalId ?? ''))
  if (owners.size === 0) return null

  async function submit(e: FormEvent) {
    e.preventDefault()
    setProblem(null)
    const on = parseDate(date)
    if (!on) return setProblem('Enter the date like 10/28/2026')
    const cents = parseCents(amount)
    if (cents === null || cents <= 0) return setProblem('Enter a positive amount, like 5,000.00')
    const moved = await props.run(() =>
      budget.moveUnits({
        accountId: props.accountId,
        fromGoalId: from || null,
        toGoalId: to || null,
        date: on,
        amount: cents,
      }),
    )
    if (moved) setAmount('')
  }

  return (
    <form className="stack stretch" onSubmit={(e) => void submit(e)}>
      <h3>Move between goals</h3>
      <div className="grid-2">
        <GoalSelect label="From" value={from} onChange={setFrom} options={props.options} />
        <GoalSelect label="To" value={to} onChange={setTo} options={props.options} />
        <label>
          Amount
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          Date
          <input value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button type="submit" disabled={!amount.trim() || from === to}>
          Move
        </button>
      </div>
      <small className="muted">
        The cost basis moves with the units, so nothing is a gain or loss until it is sold.
      </small>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </form>
  )
}

function HoldingsSection(props: {
  accountId: string
  data: AccountInvestments
  options: Option[]
  run: Run
}) {
  const holdings = useBudgetQuery(() => budget.listHoldings(props.accountId), [props.accountId])
  const list = holdings.data ?? []
  const inUse = props.data.mode === 'holdings' || list.length > 0
  const [name, setName] = useState('')
  const [goalId, setGoalId] = useState(UNASSIGNED)
  const [price, setPrice] = useState('')
  const [tradeHolding, setTradeHolding] = useState('')
  const [type, setType] = useState<'buy' | 'sell'>('buy')
  const [date, setDate] = useState(() => shortDate(todayIso()))
  const [shares, setShares] = useState('')
  const [tradePrice, setTradePrice] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  if (!inUse) return null

  const chosen = list.find((h) => h.id === tradeHolding) ?? list[0]

  async function add(e: FormEvent) {
    e.preventDefault()
    setProblem(null)
    let cents: number | null = null
    if (price.trim()) {
      cents = parsePrice(price)
      if (cents === null) return setProblem('Enter the price in dollars, like 212.34')
    }
    const added = await props.run(() =>
      budget.createHolding({
        accountId: props.accountId,
        name,
        goalId: goalId || null,
        price: cents,
      }),
    )
    if (added) {
      setName('')
      setPrice('')
    }
  }

  async function trade(e: FormEvent) {
    e.preventDefault()
    setProblem(null)
    const on = parseDate(date)
    if (!on) return setProblem('Enter the date like 10/28/2026')
    const count = parseShares(shares)
    if (count === null) return setProblem('Enter the number of shares, like 12.5')
    const each = parsePrice(tradePrice)
    if (each === null) return setProblem('Enter the price per share in dollars, like 212.34')
    if (!chosen) return
    const done = await props.run(() =>
      budget.recordTrade({ holdingId: chosen.id, type, date: on, shares: count, price: each }),
    )
    if (done) {
      setShares('')
      setTradePrice('')
    }
  }

  return (
    <section className="stack stretch">
      <h3>Holdings</h3>
      {props.data.mode === 'units' && (
        <small className="muted">
          This account shares its return in units. Holdings are for accounts set to “Holdings”.
        </small>
      )}
      {list.length > 0 && (
        <ul className="plain">
          {list.map((h) => (
            <HoldingRow key={h.id} holding={h} options={props.options} run={props.run} />
          ))}
        </ul>
      )}
      <form className="stack stretch" onSubmit={(e) => void add(e)}>
        <div className="grid-2">
          <label>
            Holding name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="VTI" />
          </label>
          <GoalSelect label="Goal" value={goalId} onChange={setGoalId} options={props.options} />
          <label>
            Price per share
            <input
              inputMode="decimal"
              placeholder="optional"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </label>
        </div>
        <div className="row">
          <button type="submit" disabled={!name.trim()}>
            Add holding
          </button>
        </div>
      </form>
      {chosen && (
        <form className="stack stretch" onSubmit={(e) => void trade(e)}>
          <h3>Record a trade</h3>
          <div className="grid-2">
            <label>
              Holding
              <select value={chosen.id} onChange={(e) => setTradeHolding(e.target.value)}>
                {list.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Trade
              <select value={type} onChange={(e) => setType(e.target.value as 'buy' | 'sell')}>
                <option value="buy">Buy</option>
                <option value="sell">Sell</option>
              </select>
            </label>
            <label>
              Shares
              <input
                inputMode="decimal"
                value={shares}
                onChange={(e) => setShares(e.target.value)}
              />
            </label>
            <label>
              Price per share
              <input
                inputMode="decimal"
                value={tradePrice}
                onChange={(e) => setTradePrice(e.target.value)}
              />
            </label>
            <label>
              Date
              <input value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          </div>
          <div className="row">
            <button type="submit" disabled={!shares.trim() || !tradePrice.trim()}>
              Record trade
            </button>
          </div>
          <small className="muted">
            A cleared transfer buys or sells a goal’s holding on its own only when the goal has
            exactly one holding in this account and that holding has a price.
          </small>
        </form>
      )}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  )
}

function HoldingRow(props: {
  holding: { id: string; name: string; goalId: string | null; price: number | null }
  options: Option[]
  run: Run
}) {
  const { holding: h } = props
  const [price, setPrice] = useState('')
  return (
    <li className="row spread">
      <span>
        {h.name}
        <span className="muted">
          {h.price === null ? ' · no price yet' : ` · ${priceText(h.price)} a share`}
        </span>
      </span>
      <span className="row">
        <select
          aria-label={`Goal for ${h.name}`}
          value={h.goalId ?? UNASSIGNED}
          onChange={(e) =>
            void props.run(() => budget.updateHolding(h.id, { goalId: e.target.value || null }))
          }
        >
          <option value={UNASSIGNED}>Unassigned</option>
          {props.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <input
          aria-label={`New price for ${h.name}`}
          inputMode="decimal"
          placeholder="New price"
          size={9}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
        <button
          type="button"
          className="secondary"
          disabled={parsePrice(price) === null}
          aria-label={`Update the price of ${h.name}`}
          onClick={async () => {
            const cents = parsePrice(price)
            if (
              cents !== null &&
              (await props.run(() => budget.updateHolding(h.id, { price: cents })))
            ) {
              setPrice('')
            }
          }}
        >
          Update
        </button>
        <button
          type="button"
          className="secondary danger"
          aria-label={`Delete ${h.name}`}
          onClick={() => void props.run(() => budget.deleteHolding(h.id))}
        >
          Delete
        </button>
      </span>
    </li>
  )
}
