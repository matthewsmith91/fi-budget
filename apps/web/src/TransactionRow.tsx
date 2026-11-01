import {
  parseCents,
  type Account,
  type CategoryGroup,
  type Goal,
  type NeedOrWant,
  type SplitInput,
  type Transaction,
} from '@budget-fi/core'
import { useEffect, useRef, useState } from 'react'
import { categoryOptions, GOAL_PREFIX, pickedValue, type ComboOption } from './combo-options.ts'
import { Combobox } from './Combobox.tsx'
import type { ConfirmOptions } from './ConfirmDialog.tsx'
import { messageOf } from './errors.ts'
import { money, parseDate, shortDate, todayIso } from './format.ts'
import {
  amountOf,
  emptyLine,
  lineOf,
  plain,
  typeAmount,
  unsplitLoss,
  type Line,
} from './register-entry.ts'

export interface Entry {
  accountId: string
  date: string
  payee: string
  splits: SplitInput[]
  /** Pre-tax pay of a deposit, for income rules on a gross basis; null clears it. */
  grossAmount: number | null
  /** The deposit this outflow takes back; null for none. */
  reversesId: string | null
  /** Paid for from the emergency fund. */
  emergency: boolean
}

interface Props {
  transaction: Transaction | null
  /** Set when editing one leg of a transfer: no payee, no splits, a category only sometimes. */
  transfer: { label: string; categoryEditable: boolean } | null
  accounts: Account[]
  defaultAccountId: string
  showAccountColumn: boolean
  groups: CategoryGroup[]
  goals: Goal[]
  /** Payee suggestions. */
  payees: ComboOption[]
  /** Income that an outflow could take back (a reversed paycheck). */
  deposits: Transaction[]
  /** Whether the household has an emergency fund to pay from. */
  hasFund: boolean
  ask: (options: ConfirmOptions) => Promise<boolean>
  /** Tells the register whether leaving now would lose typing. */
  onDirtyChange: (dirty: boolean) => void
  onCancel: () => void
  /** Rejects with the reason a write failed; the row shows it and stays open. */
  onSave: (entry: Entry) => Promise<void>
  onDelete?: () => Promise<void>
}

const list = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })

export function TransactionRow(props: Props) {
  const { transaction: t, onDirtyChange } = props
  const [fields, setFields] = useState(() => ({
    accountId: props.defaultAccountId,
    date: shortDate(t?.date ?? todayIso()),
    payee: t?.payee ?? '',
  }))
  const [lines, setLines] = useState<Line[]>(() => (t ? t.splits.map(lineOf) : [emptyLine()]))
  const [split, setSplit] = useState(lines.length > 1)
  const [gross, setGross] = useState(t?.grossAmount ? plain(t.grossAmount) : '')
  const [reversesId, setReversesId] = useState(t?.reversesId ?? '')
  const [emergency, setEmergency] = useState(t?.emergency ?? false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dateTouched, setDateTouched] = useState(false)
  const dateRef = useRef<HTMLInputElement>(null)
  const payeeRef = useRef<HTMLInputElement | null>(null)
  const amountRefs = useRef<(HTMLInputElement | null)[]>([])

  const set = (patch: Partial<typeof fields>) => setFields({ ...fields, ...patch })
  const setLine = (i: number, patch: Partial<Line>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const account = props.accounts.find((a) => a.id === fields.accountId)

  // Anything typed since the row opened (or since the last entry was saved) is worth asking about.
  const snapshot = JSON.stringify([fields, lines, split, gross, reversesId, emergency])
  const [baseline, setBaseline] = useState(snapshot)
  const dirty = snapshot !== baseline
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  const amounts = lines.map(amountOf)
  const total = amounts.reduce<number>((n, a) => n + (typeof a === 'number' ? a : 0), 0)
  // Income rules look at uncategorized inflows, and a reversal is an outflow from the same account.
  const isIncome = !props.transfer && account?.onBudget !== false && total > 0
  const showGross = isIncome && lines.every((l) => !l.categoryId)
  const reversible = props.deposits.filter(
    (d) => d.accountId === fields.accountId && d.id !== t?.id,
  )
  const showReverses =
    !props.transfer &&
    account?.onBudget !== false &&
    total < 0 &&
    (reversible.length > 0 || !!reversesId)

  // Rare, so it sits quietly among the editor's buttons. It can always be switched off; switching
  // on needs a fund and spending from a budget account.
  const showEmergency =
    !props.transfer && account?.onBudget !== false && (props.hasFund || !!t?.emergency)

  const categoryName = (line: Line) => {
    const name =
      props.groups.flatMap((g) => g.categories).find((c) => c.id === line.categoryId)?.name ??
      'no category'
    const goal = props.goals.find((g) => g.id === line.goalId)
    return goal ? `${name}: ${goal.name}` : name
  }

  async function toggleSplit() {
    setError(null)
    if (!split) {
      setLines([...lines, emptyLine()])
      return setSplit(true)
    }
    const bad = amounts.findIndex((a) => typeof a === 'string')
    if (bad >= 0) {
      amountRefs.current[bad]?.focus()
      return setError(amounts[bad] as string)
    }
    const lost = unsplitLoss(lines)
    if (lost.length > 0) {
      const ok = await props.ask({
        title: 'Unsplit this transaction?',
        message: (
          <p>
            The whole amount goes to {categoryName(lines[0]!)}.{' '}
            {list.format([...new Set(lost.map(categoryName))])} will no longer be on this
            transaction.
          </p>
        ),
        confirmLabel: 'Unsplit',
        cancelLabel: 'Keep split',
        danger: true,
      })
      if (!ok) return
    }
    // Back to one line: the first line's category carries the whole amount.
    setLines([
      {
        categoryId: lines[0]!.categoryId,
        goalId: lines[0]!.goalId,
        needOrWant: lines[0]!.needOrWant,
        outflow: total < 0 ? plain(-total) : '',
        inflow: total > 0 ? plain(total) : '',
      },
    ])
    setSplit(false)
  }

  function fail(message: string, field?: HTMLElement | null) {
    field?.focus()
    setError(message)
  }

  async function save() {
    if (saving) return
    setError(null)
    const date = parseDate(fields.date)
    if (!date) return fail('Enter the date like 10/28/2026, or type today', dateRef.current)
    const bad = amounts.findIndex((a) => typeof a === 'string')
    if (bad >= 0) return fail(amounts[bad] as string, amountRefs.current[bad])
    const splits: SplitInput[] = lines.map((l, i) => ({
      categoryId: l.categoryId || null,
      goalId: l.goalId || null,
      needOrWant: l.needOrWant || null,
      amount: amounts[i] as number,
    }))
    const empty = splits.findIndex((s) => s.amount === 0)
    if (empty >= 0) {
      return fail(
        split ? 'Every split needs an outflow or an inflow' : 'Enter an outflow or an inflow',
        amountRefs.current[empty],
      )
    }
    let grossAmount: number | null = null
    if (showGross && gross.trim() !== '') {
      const parsed = parseCents(gross)
      if (parsed === null || parsed <= 0)
        return setError('Enter gross pay as dollars, like 3100.00')
      grossAmount = parsed
    }
    setSaving(true)
    try {
      await props.onSave({
        accountId: fields.accountId,
        date,
        payee: fields.payee,
        splits,
        grossAmount,
        reversesId: showReverses ? reversesId || null : null,
        emergency: showEmergency && emergency,
      })
      if (!t) {
        // Ready for the next entry: keep the account and date, start the rest over.
        setBaseline(JSON.stringify([{ ...fields, payee: '' }, [emptyLine()], false, '', '', false]))
        setFields({ ...fields, payee: '' })
        setLines([emptyLine()])
        setSplit(false)
        setGross('')
        setReversesId('')
        setEmergency(false)
        payeeRef.current?.focus()
      }
    } catch (err) {
      // the entry stays exactly as typed
      setError(messageOf(err))
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    setError(null)
    try {
      await props.onDelete!()
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const blankFor = (line: Line) =>
    account?.onBudget === false
      ? '—'
      : line.inflow.trim() !== '' && line.outflow.trim() === ''
        ? 'Inflow: Ready to Assign'
        : 'Uncategorized'
  const label = t ? 'Edit transaction' : 'New transaction'
  const columns = props.showAccountColumn ? 7 : 6

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
      e.preventDefault()
      void save()
    }
    if (e.key === 'Escape') props.onCancel()
  }

  /** A goal option stands for its category plus that goal; a category option clears the goal. */
  const pick = (value: string): Pick<Line, 'categoryId' | 'goalId'> => {
    if (!value.startsWith(GOAL_PREFIX)) return { categoryId: value, goalId: '' }
    const goalId = value.slice(GOAL_PREFIX.length)
    return { categoryId: props.goals.find((g) => g.id === goalId)?.categoryId ?? '', goalId }
  }

  const defaultTag = (categoryId: string) =>
    props.groups.flatMap((g) => g.categories).find((c) => c.id === categoryId)?.needOrWant ===
    'need'
      ? 'need'
      : 'want'

  const categorySelect = (line: Line, i: number, name: string) => (
    <>
      <Combobox
        mode="select"
        label={name}
        options={categoryOptions(props.groups, props.goals, line)}
        value={pickedValue(line.categoryId, line.goalId)}
        blankLabel={blankFor(line)}
        disabled={props.transfer !== null && !props.transfer.categoryEditable}
        onChange={(value) => {
          const picked = pick(value)
          // An override belongs to the category it was chosen for.
          setLine(i, picked.categoryId === line.categoryId ? picked : { ...picked, needOrWant: '' })
        }}
      />
      {line.categoryId && !props.transfer && (
        <select
          className="need-want-select"
          aria-label={`Need or want${name === 'Category' ? '' : name.slice('Category'.length)}`}
          value={line.needOrWant}
          onChange={(e) => setLine(i, { needOrWant: e.target.value as NeedOrWant | '' })}
        >
          <option value="">Default ({defaultTag(line.categoryId)})</option>
          <option value="need">Need</option>
          <option value="want">Want</option>
        </select>
      )}
    </>
  )

  const amountInputs = (line: Line, i: number, suffix: string) => (
    <>
      <td className="num" data-label="Outflow">
        <input
          ref={(el) => {
            amountRefs.current[i] = el
          }}
          aria-label={`Outflow${suffix}`}
          inputMode="decimal"
          placeholder="0.00"
          value={line.outflow}
          onChange={(e) =>
            setLines(lines.map((l, j) => (j === i ? typeAmount(l, 'outflow', e.target.value) : l)))
          }
        />
      </td>
      <td className="num" data-label="Inflow">
        <input
          aria-label={`Inflow${suffix}`}
          inputMode="decimal"
          placeholder="0.00"
          value={line.inflow}
          onChange={(e) =>
            setLines(lines.map((l, j) => (j === i ? typeAmount(l, 'inflow', e.target.value) : l)))
          }
        />
      </td>
    </>
  )

  const payeeText = props.transfer ? props.transfer.label : fields.payee
  const dateInvalid = dateTouched && parseDate(fields.date) === null

  return (
    <>
      <tr className="edit-row" aria-label={label} onKeyDown={onKeyDown}>
        <td data-label="Date">
          <input
            ref={dateRef}
            aria-label="Date"
            placeholder="MM/DD/YYYY"
            title="Type a date like 10/28/2026, or today or yesterday"
            aria-invalid={dateInvalid || undefined}
            value={fields.date}
            onChange={(e) => set({ date: e.target.value })}
            onBlur={() => {
              setDateTouched(true)
              // 'today' or '10/28' becomes the date it means, so what gets saved is what is shown
              const iso = parseDate(fields.date)
              if (iso) set({ date: shortDate(iso) })
            }}
          />
        </td>
        {props.showAccountColumn && (
          <td data-label="Account">
            <select
              aria-label="Account"
              value={fields.accountId}
              disabled={!!t}
              onChange={(e) => set({ accountId: e.target.value })}
            >
              {props.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </td>
        )}
        <td data-label="Payee">
          <Combobox
            mode="text"
            label="Payee"
            options={props.payees}
            limit={8}
            value={payeeText}
            disabled={props.transfer !== null}
            autoFocus
            inputRef={(el) => {
              payeeRef.current = el
            }}
            onChange={(payee) => set({ payee })}
          />
        </td>
        {split ? (
          <>
            <td data-label="Category">
              <span className="split-total">Split ({lines.length})</span>
            </td>
            <td className="num" data-label="Outflow">
              {total < 0 ? money(-total) : ''}
            </td>
            <td className="num" data-label="Inflow">
              {total > 0 ? money(total) : ''}
            </td>
          </>
        ) : (
          <>
            <td data-label="Category">{categorySelect(lines[0]!, 0, 'Category')}</td>
            {amountInputs(lines[0]!, 0, '')}
          </>
        )}
        <td />
      </tr>
      {split &&
        lines.map((line, i) => (
          <tr
            key={i}
            className="edit-row split-line"
            aria-label={`Split ${i + 1}`}
            onKeyDown={onKeyDown}
          >
            <td className="split-gap" colSpan={props.showAccountColumn ? 3 : 2} />
            <td data-label="Category">{categorySelect(line, i, `Category ${i + 1}`)}</td>
            {amountInputs(line, i, ` ${i + 1}`)}
            <td className="cleared-col">
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove split ${i + 1}`}
                title={
                  lines.length <= 2
                    ? 'A split needs two lines. Use Unsplit to go back to one.'
                    : `Remove split ${i + 1}`
                }
                disabled={lines.length <= 2}
                onClick={() => setLines(lines.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </td>
          </tr>
        ))}
      <tr className="edit-actions">
        <td colSpan={columns}>
          {error && (
            <span className="error" role="alert">
              {error}
            </span>
          )}
          {props.transfer && (
            <span className="muted edit-note">
              A transfer has two sides. A new amount changes both; the date changes only this one.
              {!props.transfer.categoryEditable &&
                ' Only a move between a budget and a tracking account takes a category.'}
            </span>
          )}
          {showGross && (
            <label className="inline-field">
              Gross pay
              <input
                aria-label="Gross pay"
                inputMode="decimal"
                placeholder="optional"
                value={gross}
                onChange={(e) => setGross(e.target.value)}
              />
            </label>
          )}
          {showReverses && (
            <label className="inline-field">
              Takes back
              <select
                aria-label="Takes back the deposit"
                value={reversesId}
                onChange={(e) => setReversesId(e.target.value)}
              >
                <option value="">No deposit</option>
                {reversible.map((d) => (
                  <option key={d.id} value={d.id}>
                    {`${shortDate(d.date)} ${d.payee ?? 'Deposit'} ${money(d.amount)}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {showEmergency && (
            <>
              <label
                className="inline-field emergency-toggle"
                title="The fund covers it and the category keeps the spending"
              >
                <input
                  type="checkbox"
                  aria-describedby={emergency ? 'emergency-note' : undefined}
                  checked={emergency}
                  onChange={(e) => setEmergency(e.target.checked)}
                />
                Pay from the emergency fund
              </label>
              {emergency && (
                <span id="emergency-note" className="muted edit-note">
                  The money moves from the fund into this category.
                </span>
              )}
            </>
          )}
          <span className="spacer" />
          {props.onDelete && (
            <button type="button" className="secondary danger" onClick={() => void remove()}>
              Delete
            </button>
          )}
          {split && (
            <button
              type="button"
              className="secondary"
              onClick={() => setLines([...lines, emptyLine()])}
            >
              + Add split
            </button>
          )}
          {!props.transfer && (
            <button type="button" className="secondary" onClick={() => void toggleSplit()}>
              {split ? 'Unsplit' : 'Split'}
            </button>
          )}
          <button type="button" className="secondary" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" disabled={saving} onClick={() => void save()}>
            Save
          </button>
        </td>
      </tr>
    </>
  )
}
