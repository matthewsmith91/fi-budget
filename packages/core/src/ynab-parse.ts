import { parseCsv } from './csv.ts'
import { parseCents } from './money.ts'

export type DateOrder = 'MDY' | 'DMY' | 'YMD'
export type YnabCleared = 'uncleared' | 'cleared' | 'reconciled'

/** One line of YNAB's Register.csv. */
export interface RegisterRow {
  /** Position in the file, counting data rows from 1; stable, so it makes deterministic ids. */
  n: number
  account: string
  date: string
  payee: string
  /** Null for money into Ready to Assign, for transfers and for a card's payment category. */
  group: string | null
  category: string | null
  /**
   * True when YNAB put the line in the budget: it has a category, a split marker, or is
   * money into Ready to Assign or a card payment. A tracking account's own lines never do.
   */
  inBudget: boolean
  memo: string
  /** Integer cents; negative is money out. */
  amount: number
  cleared: YnabCleared
}

export interface ParsedRegister {
  rows: RegisterRow[]
  dateOrder: DateOrder
  /** True when every date could be read two ways (all days and months are 12 or under). */
  ambiguousDates: boolean
  warnings: string[]
}

/** One line of YNAB's Budget.csv. */
export interface BudgetRow {
  /** `YYYY-MM`. */
  month: string
  group: string
  category: string
  budgeted: number
  activity: number
  available: number
}

export const TRANSFER_PAYEE = /^transfer\s*:\s*(.+)$/i
const SPLIT_MEMO = /^\(split (\d+)\/(\d+)\)\s*/i
const SPLIT_CATEGORY = /^split \(\d+\/\d+\)$/i
/** Groups YNAB keeps for itself: the app derives these, so nothing is imported into them. */
const NO_CATEGORY_GROUPS = new Set(['inflow', 'credit card payments'])

function headerIndex(header: string[], ...names: string[]): number {
  const lower = header.map((h) => h.trim().toLowerCase())
  for (const name of names) {
    const i = lower.indexOf(name)
    if (i !== -1) return i
  }
  return -1
}

/**
 * The columns that name a row's category. YNAB 4 calls them Master Category and Sub Category
 * (its plain Category column holds both joined); newer exports have Category Group and Category.
 */
function categoryColumns(header: string[]) {
  const master = headerIndex(header, 'master category')
  const old = master !== -1 && headerIndex(header, 'sub category') !== -1
  return {
    group: old ? master : headerIndex(header, 'category group'),
    category: old ? headerIndex(header, 'sub category') : headerIndex(header, 'category'),
    combined: headerIndex(header, 'category group/category'),
  }
}

/** Reads "$1,234.56", "1.234,56 €", "(5.00)" and "-5" into cents; blank is 0. */
export function parseYnabAmount(raw: string): number {
  let s = raw.trim()
  if (s === '') return 0
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1)
  }
  s = s.replace(/[^\d.,-]/g, '')
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  }
  if (s.includes('-')) throw new Error(`Cannot read the amount "${raw}"`)
  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')
  let normalized: string
  if (lastDot !== -1 && lastComma !== -1) {
    // the separator that comes last is the decimal point
    const [decimal, thousands] = lastDot > lastComma ? ['.', ','] : [',', '.']
    normalized = s.replaceAll(thousands, '').replace(decimal, '.')
  } else if (lastComma !== -1) {
    // "12,5" and "12,50" are decimals; "1,234" and "1,234,567" are thousands
    normalized = /^\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replaceAll(',', '')
  } else if ((s.match(/\./g) ?? []).length > 1) {
    normalized = s.replaceAll('.', '')
  } else normalized = s
  const value = parseCents(normalized)
  if (value === null) throw new Error(`Cannot read the amount "${raw}"`)
  return negative ? -value : value
}

function detectDateOrder(dates: string[]): { order: DateOrder; ambiguous: boolean } {
  if (dates.every((d) => /^\d{4}[/.-]\d{1,2}[/.-]\d{1,2}$/.test(d)))
    return { order: 'YMD', ambiguous: false }
  const parts = dates.map((d) => d.split(/[/.-]/).map(Number))
  if (parts.some(([a]) => a! > 12)) return { order: 'DMY', ambiguous: false }
  if (parts.some(([, b]) => b! > 12)) return { order: 'MDY', ambiguous: false }
  return { order: 'MDY', ambiguous: true }
}

function toIsoDate(raw: string, order: DateOrder): string {
  const parts = raw.trim().split(/[/.-]/)
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`Cannot read the date "${raw}"`)
  }
  const [a, b, c] = parts as [string, string, string]
  const [y, m, d] = order === 'YMD' ? [a, b, c] : order === 'MDY' ? [c, a, b] : [c, b, a]
  const iso = `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  const parsed = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(iso)) {
    throw new Error(`"${raw}" is not a date (read as ${order})`)
  }
  return iso
}

function categoryOf(
  group: string,
  category: string,
  combined: string,
): { group: string | null; category: string | null } {
  let g = group.trim()
  let c = category.trim()
  if (!g && !c && combined.trim()) {
    const at = combined.indexOf(':')
    g = at === -1 ? '' : combined.slice(0, at).trim()
    c = (at === -1 ? combined : combined.slice(at + 1)).trim()
  }
  if (!c || SPLIT_CATEGORY.test(c) || NO_CATEGORY_GROUPS.has(g.toLowerCase())) {
    return { group: null, category: null }
  }
  return { group: g || 'Imported', category: c }
}

function clearedOf(raw: string): YnabCleared {
  const s = raw.trim().toLowerCase()
  if (s === 'reconciled' || s === 'r') return 'reconciled'
  if (s === 'cleared' || s === 'c') return 'cleared'
  return 'uncleared'
}

/** Reads YNAB's Register.csv ("Export Budget Data"). */
export function parseRegister(text: string, forcedOrder?: DateOrder): ParsedRegister {
  const [header, ...lines] = parseCsv(text)
  if (!header) throw new Error('The register file is empty')
  const col = {
    account: headerIndex(header, 'account'),
    date: headerIndex(header, 'date'),
    payee: headerIndex(header, 'payee'),
    ...categoryColumns(header),
    memo: headerIndex(header, 'memo'),
    outflow: headerIndex(header, 'outflow'),
    inflow: headerIndex(header, 'inflow'),
    cleared: headerIndex(header, 'cleared'),
  }
  if (col.account === -1 || col.date === -1 || col.outflow === -1 || col.inflow === -1) {
    throw new Error(
      'This does not look like YNAB’s Register.csv (it needs Account, Date, Outflow and Inflow columns)',
    )
  }
  const cell = (line: string[], i: number) => (i === -1 ? '' : (line[i] ?? ''))
  const dates = lines.map((l) => cell(l, col.date).trim()).filter(Boolean)
  const detected = detectDateOrder(dates)
  const order = forcedOrder ?? detected.order
  const warnings: string[] = []
  const rows: RegisterRow[] = []
  lines.forEach((line, i) => {
    const n = i + 1
    if (line.every((c) => c.trim() === '')) return
    try {
      const { group, category } = categoryOf(
        cell(line, col.group),
        cell(line, col.category),
        cell(line, col.combined),
      )
      const account = cell(line, col.account).trim()
      if (!account) throw new Error('no account')
      rows.push({
        n,
        account,
        date: toIsoDate(cell(line, col.date), order),
        payee: cell(line, col.payee).trim(),
        group,
        category,
        inBudget: [col.group, col.category, col.combined].some((i) => cell(line, i).trim() !== ''),
        memo: cell(line, col.memo).trim(),
        amount: parseYnabAmount(cell(line, col.inflow)) - parseYnabAmount(cell(line, col.outflow)),
        cleared: clearedOf(cell(line, col.cleared)),
      })
    } catch (error) {
      throw new Error(`Register line ${n + 1}: ${(error as Error).message}`)
    }
  })
  return {
    rows,
    dateOrder: order,
    ambiguousDates: forcedOrder === undefined && detected.ambiguous,
    warnings,
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function parseMonth(raw: string): string {
  const s = raw.trim()
  let m = /^(\d{4})-(\d\d)(?:-\d\d)?$/.exec(s)
  if (m) return `${m[1]}-${m[2]}`
  m = /^(\d\d?)\/(\d{4})$/.exec(s)
  if (m) return `${m[2]}-${m[1]!.padStart(2, '0')}`
  m = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})$/.exec(s)
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1
  if (m && month !== -1) return `${m[2]}-${String(month + 1).padStart(2, '0')}`
  throw new Error(`Cannot read the month "${raw}"`)
}

/** Reads YNAB's Budget.csv (called Plan.csv in newer exports). Rows for YNAB's own groups (Ready to Assign, card payments) are left out. */
export function parseBudget(text: string): BudgetRow[] {
  const [header, ...lines] = parseCsv(text)
  if (!header) throw new Error('The budget file is empty')
  const col = {
    month: headerIndex(header, 'month'),
    ...categoryColumns(header),
    // newer exports call the file Plan.csv and the column Assigned
    budgeted: headerIndex(header, 'budgeted', 'assigned'),
    activity: headerIndex(header, 'activity'),
    available: headerIndex(header, 'available'),
  }
  if (col.month === -1 || col.budgeted === -1) {
    throw new Error(
      'This does not look like YNAB’s Budget.csv (it needs Month and Budgeted or Assigned columns)',
    )
  }
  const cell = (line: string[], i: number) => (i === -1 ? '' : (line[i] ?? ''))
  const rows: BudgetRow[] = []
  lines.forEach((line, i) => {
    try {
      const { group, category } = categoryOf(
        cell(line, col.group),
        cell(line, col.category),
        cell(line, col.combined),
      )
      if (group === null || category === null) return
      rows.push({
        month: parseMonth(cell(line, col.month)),
        group,
        category,
        budgeted: parseYnabAmount(cell(line, col.budgeted)),
        activity: parseYnabAmount(cell(line, col.activity)),
        available: parseYnabAmount(cell(line, col.available)),
      })
    } catch (error) {
      throw new Error(`Budget line ${i + 2}: ${(error as Error).message}`)
    }
  })
  return rows
}

/** What one register row, or group of rows, becomes in the budget. */
export type PlanItem =
  | { kind: 'transaction'; row: RegisterRow }
  /** Several rows that are the lines of one split transaction. */
  | { kind: 'split'; parts: RegisterRow[] }
  /** Two rows that are the two sides of one transfer; `first` came first in the file. */
  | { kind: 'transfer'; first: RegisterRow; second: RegisterRow }

export interface Plan {
  items: PlanItem[]
  /** Rows with no amount, which the budget has no use for. */
  skippedZero: number
  /** Transfers whose other side is not in the file; they come in as plain transactions. */
  unpairedTransfers: number
  /** Split lines missing some of their siblings; they come in as separate transactions. */
  brokenSplits: number
}

const norm = (s: string) => s.trim().toLowerCase()

/** Groups register rows into transactions, split transactions and transfer pairs. */
export function planRegister(rows: readonly RegisterRow[]): Plan {
  const plan: Plan = { items: [], skippedZero: 0, unpairedTransfers: 0, brokenSplits: 0 }
  const pending = new Map<string, number[]>()
  const unpaired = new Set<number>()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const split = SPLIT_MEMO.exec(row.memo)
    if (split && Number(split[1]) === 1 && Number(split[2]) > 1) {
      const count = Number(split[2])
      const parts = [row]
      for (let j = i + 1; j < rows.length && parts.length < count; j++) {
        const next = rows[j]!
        const m = SPLIT_MEMO.exec(next.memo)
        const sameTransaction =
          m &&
          Number(m[1]) === parts.length + 1 &&
          Number(m[2]) === count &&
          next.account === row.account &&
          next.date === row.date &&
          next.payee === row.payee
        if (!sameTransaction) break
        parts.push(next)
      }
      if (parts.length === count) {
        const live = parts.filter((p) => p.amount !== 0)
        plan.skippedZero += parts.length - live.length
        if (live.length > 0) plan.items.push({ kind: 'split', parts: live })
        i += count - 1
        continue
      }
      plan.brokenSplits += parts.length
    } else if (split) plan.brokenSplits++

    if (row.amount === 0) {
      plan.skippedZero++
      continue
    }
    const transfer = TRANSFER_PAYEE.exec(row.payee)
    if (!transfer) {
      plan.items.push({ kind: 'transaction', row })
      continue
    }
    const to = norm(transfer[1]!)
    const wanted = `${to}\0${norm(row.account)}\0${row.date}\0${-row.amount}`
    const waiting = pending.get(wanted)?.shift()
    if (waiting !== undefined) {
      const first = (plan.items[waiting] as { kind: 'transaction'; row: RegisterRow }).row
      plan.items[waiting] = { kind: 'transfer', first, second: row }
      unpaired.delete(waiting)
      continue
    }
    const key = `${norm(row.account)}\0${to}\0${row.date}\0${row.amount}`
    const at = plan.items.push({ kind: 'transaction', row }) - 1
    pending.set(key, [...(pending.get(key) ?? []), at])
    unpaired.add(at)
  }
  plan.unpairedTransfers = unpaired.size
  return plan
}
