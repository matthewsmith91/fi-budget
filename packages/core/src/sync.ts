import { DELETED_COLUMN, type ChangeMessage, type ChangeValue } from './changes.ts'
import { MAX_DRIFT_MS, parseHlc } from './hlc.ts'
import { diffTries, emptyTrie, insertTimestamp, isTrie, type TrieNode } from './merkle.ts'
import type { SqlRunner, SqlValue, StorageAdapter } from './storage.ts'

/** Tables whose rows travel between devices. Anything else in a message is refused. */
export const SYNCED_TABLES: readonly string[] = [
  'households',
  'members',
  'accounts',
  'category_groups',
  'categories',
  'allocations',
  'transactions',
  'transaction_splits',
]

export class SyncError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'SyncError'
    this.status = status
  }
}

/** A row that could not be rebuilt from its messages (e.g. a constraint failed). */
export interface RowFailure {
  table: string
  rowId: string
  error: string
}

export interface ApplyResult {
  /** Messages that were new to this device. */
  applied: number
  failed: RowFailure[]
}

const IDENT = /^[a-z][a-z0-9_]*$/

interface ColumnInfo {
  name: string
  notnull: number
  dflt_value: string | null
  pk: number
}

async function tableColumns(tx: SqlRunner, table: string): Promise<ColumnInfo[]> {
  return (await tx.query(`PRAGMA table_info("${table}")`)) as unknown as ColumnInfo[]
}

function validate(
  messages: readonly ChangeMessage[],
  columns: Map<string, Set<string>>,
  wallMs: number,
) {
  for (const m of messages) {
    const hlc = parseHlc(m.timestamp)
    if (hlc.ms - wallMs > MAX_DRIFT_MS) {
      throw new SyncError('A change from another device is stamped too far in the future')
    }
    if (hlc.node !== m.deviceId) throw new SyncError('A change has a mismatched device id')
    const known = columns.get(m.table)
    if (!known) throw new SyncError(`Unknown table "${m.table}"; update the app and sync again`)
    if (m.column !== DELETED_COLUMN && (m.column === 'id' || !known.has(m.column))) {
      throw new SyncError(`Unknown column "${m.table}.${m.column}"; update the app and sync again`)
    }
    const v = m.value
    if (!(v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) {
      throw new SyncError('A change has an invalid value')
    }
    if (!m.rowId) throw new SyncError('A change has no row id')
  }
}

/**
 * Merges messages from the server into this device. Every new message goes into the log;
 * then each affected row is rebuilt from the log, taking for every column the value with
 * the newest timestamp, so the outcome does not depend on the order messages arrive in.
 * A tombstone is permanent: once any device deleted a row it stays deleted.
 *
 * Run inside a transaction. A row that violates a constraint is reported in `failed` and
 * left as it was; its messages stay in the log so devices still agree on the log.
 */
export async function applyMessages(
  tx: SqlRunner,
  incoming: readonly ChangeMessage[],
  opts: { wallMs: number },
): Promise<ApplyResult> {
  const columns = new Map<string, Set<string>>()
  const infos = new Map<string, ColumnInfo[]>()
  for (const table of SYNCED_TABLES) {
    if (!IDENT.test(table)) continue
    const info = await tableColumns(tx, table)
    infos.set(table, info)
    columns.set(table, new Set(info.map((c) => c.name)))
  }
  validate(incoming, columns, opts.wallMs)

  const touched = new Map<string, { table: string; rowId: string }>()
  let applied = 0
  for (const m of incoming) {
    const inserted = await tx.query(
      `INSERT INTO messages (timestamp, table_name, row_id, column_name, value, device_id, synced)
       VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(timestamp) DO NOTHING RETURNING 1 AS x`,
      [m.timestamp, m.table, m.rowId, m.column, m.value, m.deviceId],
    )
    if (inserted.length === 0) continue
    applied++
    touched.set(`${m.table}\0${m.rowId}`, { table: m.table, rowId: m.rowId })
  }

  // A row can fail only because something it points at has not been rebuilt yet (a child
  // before its parent); one retry after the rest of the batch settles that.
  let pending = [...touched.values()]
  let failed: RowFailure[] = []
  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
    failed = []
    for (const { table, rowId } of pending) {
      const error = await rebuildRow(tx, table, rowId, infos.get(table)!)
      if (error) failed.push({ table, rowId, error })
    }
    pending = failed.map((f) => ({ table: f.table, rowId: f.rowId }))
  }
  return { applied, failed }
}

interface LatestRow {
  column_name: string
  value: ChangeValue
}

/** Rebuilds one row from its newest messages. Returns an error text if the database refused it. */
async function rebuildRow(
  tx: SqlRunner,
  table: string,
  rowId: string,
  info: ColumnInfo[],
): Promise<string | null> {
  await tx.exec('SAVEPOINT rebuild_row')
  try {
    const latest = await tx.query<LatestRow & Record<string, never>>(
      `SELECT m.column_name, m.value FROM messages m
       WHERE m.table_name = ? AND m.row_id = ?
         AND m.timestamp = (SELECT MAX(timestamp) FROM messages
                            WHERE table_name = m.table_name AND row_id = m.row_id
                              AND column_name = m.column_name)`,
      [table, rowId],
    )
    if (latest.some((r) => r.column_name === DELETED_COLUMN)) {
      await tx.exec(`DELETE FROM "${table}" WHERE id = ?`, [rowId])
    } else {
      const known = new Set(info.map((c) => c.name))
      const values = new Map<string, SqlValue>()
      for (const r of latest) if (known.has(r.column_name)) values.set(r.column_name, r.value)
      const [current] = await tx.query(`SELECT * FROM "${table}" WHERE id = ?`, [rowId])
      if (current) {
        const changed = [...values].filter(([c, v]) => current[c] !== v)
        if (changed.length > 0) {
          await tx.exec(
            `UPDATE "${table}" SET ${changed.map(([c]) => `"${c}" = ?`).join(', ')} WHERE id = ?`,
            [...changed.map(([, v]) => v), rowId],
          )
        }
      } else {
        // The messages of a new row can arrive in separate batches; wait until every
        // required column is here rather than inserting half a row.
        const complete = info.every(
          (c) => c.pk > 0 || c.notnull === 0 || c.dflt_value !== null || values.has(c.name),
        )
        if (complete) {
          const names = ['id', ...values.keys()]
          await tx.exec(
            `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
            [rowId, ...values.values()],
          )
        }
      }
    }
    await tx.exec('RELEASE rebuild_row')
    return null
  } catch (err) {
    await tx.exec('ROLLBACK TO rebuild_row')
    await tx.exec('RELEASE rebuild_row')
    return err instanceof Error ? err.message : String(err)
  }
}

// ---------------------------------------------------------------------------------------
// Transport and engine
// ---------------------------------------------------------------------------------------

export interface SyncRequest {
  /** The server position this device has already pulled up to. */
  cursor: number
  messages: ChangeMessage[]
}

export interface SyncResponse {
  messages: ChangeMessage[]
  cursor: number
  hasMore: boolean
  /** Root hash of the server's trie after storing this push. */
  root: number
}

export interface RangePage {
  messages: ChangeMessage[]
  /** Resume point for the next page, or null on the last. */
  next: number | null
}

/** How a device reaches the server. HTTP in the app; a fake in tests. */
export interface SyncTransport {
  sync(request: SyncRequest): Promise<SyncResponse>
  trie(): Promise<TrieNode>
  messagesFrom(from: string, after: number): Promise<RangePage>
}

export interface SyncResult {
  pushed: number
  pulled: number
  /** The tries disagreed after the normal exchange, so a range was re-exchanged. */
  repaired: boolean
  /** Device and server hold the same messages (as far as could be told). */
  converged: boolean
  failed: RowFailure[]
}

export interface SyncStatus {
  /** Local changes the server does not have yet. */
  pending: number
  lastSyncAt: string | null
}

export interface SyncEngine {
  /** Runs a sync; a call made while one is running joins it. */
  sync(): Promise<SyncResult>
  status(): Promise<SyncStatus>
  /** Forget cached state; call after the budget file is replaced. */
  reset(): void
}

export const PUSH_BATCH = 500
const CURSOR_KEY = 'server_cursor'
const LAST_SYNC_KEY = 'last_sync_at'

async function getState(db: SqlRunner, key: string): Promise<string | null> {
  const [row] = await db.query<{ value: string }>('SELECT value FROM sync_state WHERE key = ?', [
    key,
  ])
  return row?.value ?? null
}

const setState = (db: SqlRunner, key: string, value: string) =>
  db.exec(
    'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  )

export function createSyncEngine(deps: {
  adapter: StorageAdapter
  transport: SyncTransport
  /** ISO time, the same source the rest of the domain layer uses. */
  now: () => string
}): SyncEngine {
  const { adapter, transport, now } = deps
  let running: Promise<SyncResult> | undefined
  let trie: TrieNode | undefined
  let watermark = 0

  /** This device's trie, kept in memory and topped up from the log by rowid. */
  async function localTrie(): Promise<TrieNode> {
    const [max] = await adapter.query<{ r: number | null }>('SELECT MAX(rowid) AS r FROM messages')
    if (!trie || (max?.r ?? 0) < watermark) {
      trie = emptyTrie()
      watermark = 0
    }
    const rows = await adapter.query<{ r: number; t: string }>(
      'SELECT rowid AS r, timestamp AS t FROM messages WHERE rowid > ? ORDER BY rowid',
      [watermark],
    )
    for (const row of rows) {
      insertTimestamp(trie, row.t)
      watermark = row.r
    }
    return trie
  }

  async function unsynced(): Promise<ChangeMessage[]> {
    const rows = await adapter.query<{
      timestamp: string
      table_name: string
      row_id: string
      column_name: string
      value: ChangeValue
      device_id: string
    }>(
      `SELECT timestamp, table_name, row_id, column_name, value, device_id FROM messages
       WHERE synced = 0 ORDER BY timestamp LIMIT ?`,
      [PUSH_BATCH],
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

  /** Pushes everything unsynced and pulls everything new, until both are drained. */
  async function exchange(): Promise<{
    pushed: number
    pulled: number
    root: number
    failed: RowFailure[]
  }> {
    let cursor = Number((await getState(adapter, CURSOR_KEY)) ?? 0)
    let pushed = 0
    let pulled = 0
    let root = 0
    const failed: RowFailure[] = []
    for (;;) {
      const batch = await unsynced()
      const res = await transport.sync({ cursor, messages: batch })
      const applied = await adapter.transaction(async (tx) => {
        const result = await applyMessages(tx, res.messages, { wallMs: Date.parse(now()) })
        // The server has these now, whether or not it echoed them back.
        for (const m of batch) {
          await tx.exec('UPDATE messages SET synced = 1 WHERE timestamp = ?', [m.timestamp])
        }
        await setState(tx, CURSOR_KEY, String(res.cursor))
        return result
      })
      cursor = res.cursor
      root = res.root
      pushed += batch.length
      pulled += applied.applied
      failed.push(...applied.failed)
      if (!res.hasMore && batch.length < PUSH_BATCH) break
    }
    return { pushed, pulled, root, failed }
  }

  /** Re-exchanges everything from the earliest minute where the two tries disagree. */
  async function repair(): Promise<{ converged: boolean; failed: RowFailure[]; pulled: number }> {
    const server = await transport.trie()
    if (!isTrie(server)) throw new SyncError('The server sent an invalid sync summary')
    const divergence = diffTries(await localTrie(), server)
    if (divergence === null) return { converged: true, failed: [], pulled: 0 }
    const from = new Date(divergence).toISOString()

    let pulled = 0
    const failed: RowFailure[] = []
    for (let after = 0, more = true; more;) {
      const page = await transport.messagesFrom(from, after)
      const applied = await adapter.transaction((tx) =>
        applyMessages(tx, page.messages, { wallMs: Date.parse(now()) }),
      )
      pulled += applied.applied
      failed.push(...applied.failed)
      more = page.next !== null
      after = page.next ?? after
    }
    // Offer the server our side of the range too; it keeps only what it lacks.
    await adapter.exec('UPDATE messages SET synced = 0 WHERE timestamp >= ?', [from])
    const sent = await exchange()
    failed.push(...sent.failed)
    pulled += sent.pulled

    const after = await transport.trie()
    return {
      converged: isTrie(after) && diffTries(await localTrie(), after) === null,
      failed,
      pulled,
    }
  }

  async function run(): Promise<SyncResult> {
    const sent = await exchange()
    const failed = sent.failed
    let pulled = sent.pulled
    let repaired = false
    let converged = (await localTrie()).hash === sent.root
    if (!converged) {
      // Either someone pushed in the meantime (harmless) or the logs really differ.
      repaired = true
      const fix = await repair()
      converged = fix.converged
      failed.push(...fix.failed)
      pulled += fix.pulled
    }
    await setState(adapter, LAST_SYNC_KEY, now())
    return { pushed: sent.pushed, pulled, repaired, converged, failed }
  }

  return {
    sync() {
      running ??= run().finally(() => {
        running = undefined
      })
      return running
    },
    async status() {
      const [row] = await adapter.query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM messages WHERE synced = 0',
      )
      return { pending: row?.n ?? 0, lastSyncAt: await getState(adapter, LAST_SYNC_KEY) }
    },
    reset() {
      trie = undefined
      watermark = 0
    },
  }
}

/** The server's endpoints over fetch. Same origin, so the session cookie rides along. */
export function httpSyncTransport(
  opts: { base?: string; fetch?: typeof fetch } = {},
): SyncTransport {
  const base = opts.base ?? '/api/sync'
  const doFetch = opts.fetch ?? ((...args) => fetch(...args))

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...init?.headers },
      })
    } catch {
      throw new SyncError('Could not reach the server')
    }
    if (res.status === 401) throw new SyncError('Sign in to sync', 401)
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new SyncError(body?.error ?? `The server refused the sync (${res.status})`, res.status)
    }
    return (await res.json()) as T
  }

  return {
    sync: (request) => call('', { method: 'POST', body: JSON.stringify(request) }),
    trie: async () => (await call<{ trie: TrieNode }>('/trie')).trie,
    messagesFrom: (from, after) =>
      call(`/messages?from=${encodeURIComponent(from)}&after=${after}`),
  }
}
