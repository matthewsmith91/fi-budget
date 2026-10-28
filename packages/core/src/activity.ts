import { DELETED_COLUMN, type ChangeValue } from './changes.ts'
import type { CrudDeps } from './crud.ts'
import { cents, formatCents } from './money.ts'
import type { SqlRunner } from './storage.ts'

/** Which person a device belongs to, so the activity feed can say who made a change. */
export interface Device {
  id: string
  name: string
  memberId: string | null
}

export type ActivityKind = 'created' | 'changed' | 'deleted'

export interface ActivityEvent {
  /** Pass as `before` to get the events older than this one. */
  cursor: string
  /** When it happened, as an ISO time. */
  at: string
  deviceId: string
  /** The device's name and its person, when this budget knows them. */
  deviceName: string | null
  memberName: string | null
  kind: ActivityKind
  table: FeedTable
  rowId: string
  summary: string
  /** For a change, the fields that were edited. */
  fields: string[]
}

export interface ActivityPage {
  /** Newest first. */
  events: ActivityEvent[]
  /** The `before` for the next page; null when this was the last one. */
  next: string | null
}

export interface ActivityApi {
  /** The record of who changed what, built from the change log. Newest first. */
  listActivity(opts?: { limit?: number; before?: string }): Promise<ActivityPage>
  /** This device's name and person; null until set. */
  getDevice(): Promise<Device | null>
  /** Tells the budget which person is using this device. Shared, so every device can show it. */
  setDevice(input: { name: string; memberId: string | null }): Promise<Device>
}

const FEED_TABLES = [
  'accounts',
  'category_groups',
  'categories',
  'allocations',
  'transactions',
  'transaction_splits',
] as const
type FeedTable = (typeof FEED_TABLES)[number]

const isFeedTable = (t: string): t is FeedTable => (FEED_TABLES as readonly string[]).includes(t)

const NOUN: Record<FeedTable, string> = {
  accounts: 'account',
  category_groups: 'category group',
  categories: 'category',
  allocations: 'allocation',
  transactions: 'transaction',
  transaction_splits: 'transaction',
}

interface MessageRow {
  timestamp: string
  table_name: string
  row_id: string
  column_name: string
  value: ChangeValue
  device_id: string
}

interface Group {
  table: FeedTable
  rowId: string
  deviceId: string
  /** Newest first, as read. */
  messages: MessageRow[]
  columns: Set<string>
  /** A delete stands alone: nothing older belongs to the same action. */
  sealed: boolean
}

const money = (value: ChangeValue) => formatCents(cents(typeof value === 'number' ? value : 0))

/** A row's name as the log last recorded it; works for rows that have since been deleted. */
async function lastValue(
  db: SqlRunner,
  table: string,
  rowId: string,
  column: string,
): Promise<ChangeValue> {
  const [row] = await db.query<{ value: ChangeValue }>(
    `SELECT value FROM messages WHERE table_name = ? AND row_id = ? AND column_name = ?
     ORDER BY timestamp DESC LIMIT 1`,
    [table, rowId, column],
  )
  return row?.value ?? null
}

async function nameOf(db: SqlRunner, table: string, rowId: ChangeValue, fallback: string) {
  if (typeof rowId !== 'string') return fallback
  const name = await lastValue(db, table, rowId, 'name')
  return typeof name === 'string' && name ? name : fallback
}

async function transactionLabel(db: SqlRunner, rowId: string) {
  const payee = await lastValue(db, 'transactions', rowId, 'payee')
  return typeof payee === 'string' && payee ? `“${payee}”` : 'a transaction'
}

async function describe(db: SqlRunner, g: Group, kind: ActivityKind, fields: string[]) {
  // The newest value written for each column in this group.
  const values = new Map<string, ChangeValue>()
  for (const m of [...g.messages].reverse()) values.set(m.column_name, m.value)
  const noun = NOUN[g.table]
  const changed =
    fields.length > 0 ? ` (${fields.map((f) => f.replaceAll('_', ' ')).join(', ')})` : ''

  if (g.table === 'allocations') {
    if (kind === 'created') {
      const amount = values.get('amount')
      const category = await nameOf(
        db,
        'categories',
        values.get('category_id') ?? null,
        'a category',
      )
      const month = values.get('month')
      const into =
        typeof amount === 'number' && amount < 0
          ? `Took ${money(-amount)} out of`
          : `Assigned ${money(amount ?? 0)} to`
      return `${into} ${category} for ${String(month)}`
    }
    return `${kind === 'deleted' ? 'Deleted' : 'Changed'} an allocation`
  }

  if (g.table === 'transactions' || g.table === 'transaction_splits') {
    const transactionId =
      g.table === 'transactions'
        ? g.rowId
        : String(await lastValue(db, 'transaction_splits', g.rowId, 'transaction_id'))
    const label = await transactionLabel(db, transactionId)
    if (g.table === 'transaction_splits') return `Changed the category or amount of ${label}`
    if (kind === 'created') {
      const account = await nameOf(db, 'accounts', values.get('account_id') ?? null, 'an account')
      const amount = values.get('amount')
      if (values.get('transfer_pair_id')) {
        return `Transferred ${money(typeof amount === 'number' ? Math.abs(amount) : 0)} ${typeof amount === 'number' && amount < 0 ? 'out of' : 'into'} ${account}`
      }
      return `Added ${label} for ${money(amount ?? 0)} in ${account}`
    }
    return `${kind === 'deleted' ? 'Deleted' : 'Changed'} ${label}${changed}`
  }

  const table = g.table
  const created = values.get('name')
  const name =
    kind === 'created' && typeof created === 'string' && created
      ? created
      : await nameOf(db, table, g.rowId, `a ${noun}`)
  const quoted = name === `a ${noun}` ? name : `“${name}”`
  if (kind === 'created') return `Added ${noun} ${quoted}`
  if (kind === 'deleted') return `Deleted ${noun} ${quoted}`
  return `Changed ${noun} ${quoted}${changed}`
}

async function toEvent(
  db: SqlRunner,
  g: Group,
  people: Map<string, { deviceName: string; memberName: string | null }>,
): Promise<ActivityEvent | null> {
  const columns = g.messages.map((m) => m.column_name)
  const kind: ActivityKind = columns.includes(DELETED_COLUMN)
    ? 'deleted'
    : columns.includes('created_at')
      ? 'created'
      : 'changed'
  // A split is created and deleted along with its transaction, which has its own event.
  if (g.table === 'transaction_splits' && kind !== 'changed') return null
  const fields = kind === 'changed' ? columns.toReversed() : []
  // Reordering is housekeeping, not something to read about.
  if (kind === 'changed' && fields.every((f) => f === 'sort')) return null
  const newest = g.messages[0]!
  const person = people.get(g.deviceId)
  return {
    cursor: g.messages[g.messages.length - 1]!.timestamp,
    at: newest.timestamp.slice(0, 24),
    deviceId: g.deviceId,
    deviceName: person?.deviceName ?? null,
    memberName: person?.memberName ?? null,
    kind,
    table: g.table,
    rowId: g.rowId,
    summary: await describe(db, g, kind, fields),
    fields,
  }
}

const MAX_LIMIT = 200

export function activityApi({
  adapter,
  now,
  changes: log,
  deviceId,
  mode,
}: CrudDeps & { deviceId: string; mode: 'local' | 'sync' }): ActivityApi {
  async function getDevice(db: SqlRunner): Promise<Device | null> {
    const [row] = await db.query<{ id: string; name: string; member_id: string | null }>(
      'SELECT id, name, member_id FROM devices WHERE id = ?',
      [deviceId],
    )
    return row ? { id: row.id, name: row.name, memberId: row.member_id } : null
  }

  return {
    getDevice: () => getDevice(adapter),

    async setDevice({ name, memberId }) {
      const clean = name.trim()
      if (!clean) throw new Error('Device name is required')
      return adapter.transaction(async (tx) => {
        if (memberId) {
          const [member] = await tx.query('SELECT 1 AS x FROM members WHERE id = ?', [memberId])
          if (!member) throw new Error('Person not found')
        }
        const changes = log(tx)
        if (await getDevice(tx)) {
          await changes.update('devices', deviceId, { name: clean, member_id: memberId, mode })
        } else {
          await changes.insert('devices', {
            id: deviceId,
            member_id: memberId,
            name: clean,
            mode,
            created_at: now(),
          })
        }
        return (await getDevice(tx))!
      })
    },

    async listActivity({ limit = 50, before } = {}) {
      const size = Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT)
      return adapter.transaction(async (tx) => {
        const people = new Map<string, { deviceName: string; memberName: string | null }>()
        for (const d of await tx.query<{ id: string; name: string; member: string | null }>(
          `SELECT d.id AS id, d.name AS name, m.display_name AS member
           FROM devices d LEFT JOIN members m ON m.id = d.member_id`,
        )) {
          people.set(d.id, { deviceName: d.name, memberName: d.member })
        }

        const events: ActivityEvent[] = []
        const state: { open: Group | null } = { open: null }
        let cursor = before
        let exhausted = false
        const close = async () => {
          if (!state.open) return
          const event = await toEvent(tx, state.open, people)
          state.open = null
          if (event) events.push(event)
        }
        const batch = Math.max(200, size * 10)
        while (!exhausted && events.length <= size) {
          const rows: MessageRow[] = await tx.query<MessageRow & Record<string, never>>(
            `SELECT timestamp, table_name, row_id, column_name, value, device_id FROM messages
             WHERE table_name IN (${FEED_TABLES.map(() => '?').join(', ')})
             ${cursor === undefined ? '' : 'AND timestamp < ?'}
             ORDER BY timestamp DESC LIMIT ?`,
            [...FEED_TABLES, ...(cursor === undefined ? [] : [cursor]), batch],
          )
          if (rows.length < batch) exhausted = true
          for (const m of rows) {
            if (events.length > size) break
            cursor = m.timestamp
            const table = m.table_name
            if (!isFeedTable(table)) continue
            const group = state.open
            // Messages carry no write id, so one action is told from the next by what a
            // single write can't do: set a column twice, follow a delete, or continue past
            // the `created_at` that ends every insert.
            const continues =
              group !== null &&
              !group.sealed &&
              group.table === table &&
              group.rowId === m.row_id &&
              group.deviceId === m.device_id &&
              !group.columns.has(m.column_name) &&
              m.column_name !== 'created_at'
            if (continues) {
              group.messages.push(m)
              group.columns.add(m.column_name)
            } else {
              await close()
              state.open = {
                table,
                rowId: m.row_id,
                deviceId: m.device_id,
                messages: [m],
                columns: new Set([m.column_name]),
                sealed: m.column_name === DELETED_COLUMN,
              }
            }
          }
        }
        if (exhausted) await close()
        const more = events.length > size
        const page = events.slice(0, size)
        return { events: page, next: more ? page[page.length - 1]!.cursor : null }
      })
    },
  }
}
