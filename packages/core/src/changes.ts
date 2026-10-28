import { formatHlc, nextHlc, parseHlc, type Hlc } from './hlc.ts'
import type { SqlRunner, SqlValue } from './storage.ts'

/** The column a delete is recorded under; its value is always 1. */
export const DELETED_COLUMN = '_deleted'

export type ChangeValue = string | number | null

/** One field of one row changing. The unit that sync pushes and merges. */
export interface ChangeMessage {
  /** HLC timestamp; unique per message and ordered by when it happened. */
  timestamp: string
  table: string
  rowId: string
  column: string
  value: ChangeValue
  deviceId: string
}

/**
 * Every write to a synced table goes through here: the row changes and its messages
 * are recorded inside the caller's transaction, so the log can never disagree with the
 * data. Obtain one per transaction.
 */
export interface ChangeLog {
  /** Inserts `row` (which must include `id`) and logs one message per other column. */
  insert(table: string, row: Record<string, ChangeValue>): Promise<void>
  /** Sets the columns that differ from the stored row; logs nothing if none do. */
  update(table: string, id: string, changes: Record<string, ChangeValue>): Promise<void>
  delete(table: string, id: string): Promise<void>
}

export interface ChangeLogDeps {
  deviceId: string
  /** ISO time; the same source the rest of the domain layer uses for `created_at`. */
  now: () => string
}

const IDENT = /^[a-z][a-z0-9_]*$/

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Invalid identifier "${name}"`)
  return `"${name}"`
}

export function changeLog(tx: SqlRunner, { deviceId, now }: ChangeLogDeps): ChangeLog {
  // Loaded on first use, then advanced in memory for the rest of this transaction.
  let last: Hlc | null | undefined

  async function stamp(): Promise<string> {
    if (last === undefined) {
      const [row] = await tx.query<{ t: string | null }>('SELECT MAX(timestamp) AS t FROM messages')
      last = row?.t ? parseHlc(row.t) : null
    }
    last = nextHlc(last, Date.parse(now()), deviceId)
    return formatHlc(last)
  }

  async function record(table: string, rowId: string, column: string, value: ChangeValue) {
    await tx.exec(
      'INSERT INTO messages (timestamp, table_name, row_id, column_name, value, device_id) VALUES (?, ?, ?, ?, ?, ?)',
      [await stamp(), table, rowId, column, value, deviceId],
    )
  }

  return {
    async insert(table, row) {
      const { id, ...fields } = row
      if (typeof id !== 'string' || !id) throw new Error(`Insert into ${table} needs a row id`)
      const columns = Object.keys(row)
      await tx.exec(
        `INSERT INTO ${ident(table)} (${columns.map(ident).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((c) => row[c]!),
      )
      for (const [column, value] of Object.entries(fields)) await record(table, id, column, value)
    },
    async update(table, id, changes) {
      const [current] = await tx.query(`SELECT * FROM ${ident(table)} WHERE id = ?`, [id])
      if (!current) throw new Error(`${table} row ${id} not found`)
      const changed = Object.entries(changes).filter(([column, value]) => current[column] !== value)
      if (changed.length === 0) return
      await tx.exec(
        `UPDATE ${ident(table)} SET ${changed.map(([c]) => `${ident(c)} = ?`).join(', ')} WHERE id = ?`,
        [...changed.map(([, v]): SqlValue => v), id],
      )
      for (const [column, value] of changed) await record(table, id, column, value)
    },
    async delete(table, id) {
      await tx.exec(`DELETE FROM ${ident(table)} WHERE id = ?`, [id])
      await record(table, id, DELETED_COLUMN, 1)
    },
  }
}

interface MessageRow {
  timestamp: string
  table_name: string
  row_id: string
  column_name: string
  value: ChangeValue
  device_id: string
}

/** Messages in timestamp order, optionally only those after `after` (what a sync pull asks for). */
export async function listMessages(
  db: SqlRunner,
  opts: { after?: string; limit?: number } = {},
): Promise<ChangeMessage[]> {
  const rows = await db.query<MessageRow & Record<string, never>>(
    `SELECT timestamp, table_name, row_id, column_name, value, device_id FROM messages
     ${opts.after === undefined ? '' : 'WHERE timestamp > ?'} ORDER BY timestamp ${opts.limit === undefined ? '' : 'LIMIT ?'}`,
    [
      ...(opts.after === undefined ? [] : [opts.after]),
      ...(opts.limit === undefined ? [] : [opts.limit]),
    ],
  )
  return rows.map((r) => ({
    timestamp: r.timestamp,
    table: r.table_name,
    rowId: r.row_id,
    column: r.column_name,
    value: r.value,
    deviceId: r.device_id,
  }))
}
