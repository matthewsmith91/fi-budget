import express, { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { AuthError } from './auth.ts'
import { requireUser, sessionMiddleware } from './auth-routes.ts'
import { emptyTrie, insertTimestamp, type TrieNode } from './merkle.ts'

/** One field of one row changing; the same shape the devices produce. */
export interface ChangeMessage {
  timestamp: string
  table: string
  rowId: string
  column: string
  value: string | number | null
  deviceId: string
}

export interface SyncDeps {
  db: DatabaseSync
  /** Injectable clock, in epoch milliseconds. */
  now?: () => number
}

/** Messages accepted per push, and returned per pull; devices loop for the rest. */
export const BATCH_LIMIT = 1000
const MAX_VALUE_LENGTH = 100_000
const MAX_DRIFT_MS = 5 * 60 * 1000

const HLC = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)-[0-9A-F]{4}-([0-9a-f]{16})$/
const IDENT = /^[a-z][a-z0-9_]*$/
/** Largest budget file a device may upload. A household's file is a few megabytes. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0')
const ISO_PREFIX = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/

/**
 * Checks a pushed batch. The server never looks inside a message beyond its shape, so a
 * newer app's columns pass through, but a malformed timestamp or one far in the future
 * (which would drag every device's clock forward) is refused.
 */
export function parseMessages(body: unknown, nowMs: number): ChangeMessage[] {
  if (!Array.isArray(body)) throw new AuthError(400, 'messages must be a list')
  if (body.length > BATCH_LIMIT) throw new AuthError(400, `At most ${BATCH_LIMIT} messages at once`)
  return body.map((raw, i) => {
    const bad = (why: string) => new AuthError(400, `Message ${i}: ${why}`)
    if (typeof raw !== 'object' || raw === null) throw bad('not an object')
    const m = raw as Record<string, unknown>
    const hlc = typeof m.timestamp === 'string' ? HLC.exec(m.timestamp) : null
    if (!hlc) throw bad('malformed timestamp')
    if (Date.parse(hlc[1]!) > nowMs + MAX_DRIFT_MS) throw bad('timestamp is too far ahead')
    if (m.deviceId !== hlc[2]) throw bad('device id does not match the timestamp')
    if (typeof m.table !== 'string' || !IDENT.test(m.table)) throw bad('invalid table')
    if (typeof m.column !== 'string' || !(IDENT.test(m.column) || m.column === '_deleted')) {
      throw bad('invalid column')
    }
    if (typeof m.rowId !== 'string' || m.rowId.length === 0 || m.rowId.length > 200) {
      throw bad('invalid row id')
    }
    const v = m.value
    const ok =
      v === null ||
      (typeof v === 'string' && v.length <= MAX_VALUE_LENGTH) ||
      (typeof v === 'number' && Number.isFinite(v))
    if (!ok) throw bad('invalid value')
    return {
      timestamp: m.timestamp as string,
      table: m.table,
      rowId: m.rowId,
      column: m.column,
      value: v,
      deviceId: m.deviceId as string,
    }
  })
}

interface StoredRow {
  seq: number
  timestamp: string
  device_id: string
  payload: string
}

function toMessage(row: StoredRow): ChangeMessage {
  const p = JSON.parse(row.payload) as Pick<ChangeMessage, 'table' | 'rowId' | 'column' | 'value'>
  return {
    timestamp: row.timestamp,
    table: p.table,
    rowId: p.rowId,
    column: p.column,
    value: p.value,
    deviceId: row.device_id,
  }
}

/**
 * The relayed change log. Messages are kept in arrival order (`seq`), which is what a
 * device's cursor counts; a message is stored once, however many times it is pushed.
 */
export class MessageStore {
  private trie: TrieNode | undefined

  constructor(private readonly db: DatabaseSync) {}

  /** Built from the log on first use, then kept current as messages arrive. */
  merkle(): TrieNode {
    if (!this.trie) {
      const trie = emptyTrie()
      const rows = this.db.prepare('SELECT timestamp FROM server_messages').all() as {
        timestamp: string
      }[]
      for (const { timestamp } of rows) insertTimestamp(trie, timestamp)
      this.trie = trie
    }
    return this.trie
  }

  /** Stores the messages not already held and returns how many were new. */
  store(messages: readonly ChangeMessage[], receivedAt: string): number {
    const trie = this.merkle()
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO server_messages (timestamp, device_id, payload, received_at) VALUES (?, ?, ?, ?)',
    )
    let added = 0
    this.db.exec('BEGIN')
    try {
      const fresh: string[] = []
      for (const m of messages) {
        const payload = JSON.stringify({
          table: m.table,
          rowId: m.rowId,
          column: m.column,
          value: m.value,
        })
        if (insert.run(m.timestamp, m.deviceId, payload, receivedAt).changes > 0) {
          fresh.push(m.timestamp)
          added++
        }
      }
      this.db.exec('COMMIT')
      // Only after the commit, so a failed batch never leaves the trie ahead of the log.
      for (const timestamp of fresh) insertTimestamp(trie, timestamp)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return added
  }

  maxSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS s FROM server_messages').get() as {
      s: number | null
    }
    return row.s ?? 0
  }

  /** Messages that arrived after `cursor`, oldest first, with the cursor to resume from. */
  after(cursor: number): { messages: ChangeMessage[]; cursor: number; hasMore: boolean } {
    const max = this.maxSeq()
    // A cursor from beyond the log means the server's data was restored from an older copy.
    if (cursor > max) return { messages: [], cursor: max, hasMore: false }
    const rows = this.db
      .prepare('SELECT * FROM server_messages WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(cursor, BATCH_LIMIT + 1) as unknown as StoredRow[]
    const page = rows.slice(0, BATCH_LIMIT)
    return {
      messages: page.map(toMessage),
      cursor: page.length > 0 ? page[page.length - 1]!.seq : cursor,
      hasMore: rows.length > BATCH_LIMIT,
    }
  }

  /** Messages stamped at or after `from` that arrived after `after`; `next` is null on the last page. */
  from(from: string, after: number): { messages: ChangeMessage[]; next: number | null } {
    const rows = this.db
      .prepare(
        'SELECT * FROM server_messages WHERE seq > ? AND timestamp >= ? ORDER BY seq LIMIT ?',
      )
      .all(after, from, BATCH_LIMIT + 1) as unknown as StoredRow[]
    const page = rows.slice(0, BATCH_LIMIT)
    return {
      messages: page.map(toMessage),
      next: rows.length > BATCH_LIMIT ? page[page.length - 1]!.seq : null,
    }
  }
}

export interface FileInfo {
  /** The log position the file already contains; a new device pulls from here. */
  cursor: number
  size: number
  createdAt: string
}

/** The latest full budget file. Opaque to the server: it is stored and handed back whole. */
export class FileStore {
  constructor(private readonly db: DatabaseSync) {}

  info(): FileInfo | null {
    const row = this.db
      .prepare('SELECT cursor, length(bytes) AS size, created_at FROM budget_file WHERE id = 1')
      .get() as { cursor: number; size: number; created_at: string } | undefined
    return row ? { cursor: row.cursor, size: row.size, createdAt: row.created_at } : null
  }

  get(): { cursor: number; bytes: Uint8Array } | null {
    const row = this.db.prepare('SELECT cursor, bytes FROM budget_file WHERE id = 1').get() as
      { cursor: number; bytes: Uint8Array } | undefined
    return row ?? null
  }

  /** Replaces the file unless the one held already reaches further into the log. */
  put(bytes: Uint8Array, cursor: number, userId: string, at: string): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO budget_file (id, cursor, bytes, created_at, created_by) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, bytes = excluded.bytes,
           created_at = excluded.created_at, created_by = excluded.created_by
         WHERE excluded.cursor >= budget_file.cursor`,
      )
      .run(cursor, bytes, at, userId)
    return result.changes > 0
  }
}

export function createSyncRouter(deps: SyncDeps): Router {
  const now = deps.now ?? Date.now
  const store = new MessageStore(deps.db)
  const files = new FileStore(deps.db)
  const router = Router()
  router.use(sessionMiddleware({ db: deps.db, now }), requireUser)

  // Push what the device has not sent yet and pull what arrived since its cursor, in one trip.
  router.post('/', (req, res) => {
    const cursor = (req.body as { cursor?: unknown } | undefined)?.cursor
    if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) {
      throw new AuthError(400, 'cursor must be a non-negative integer')
    }
    const messages = parseMessages((req.body as { messages?: unknown }).messages ?? [], now())
    store.store(messages, new Date(now()).toISOString())
    res.json({
      ...store.after(cursor),
      root: store.merkle().hash,
      fileCursor: files.info()?.cursor ?? null,
    })
  })

  // What the server holds, so a device can tell whether turning on sync would upload its
  // budget, download the household's, or collide with a different one.
  router.get('/info', (_req, res) => {
    res.json({ messages: store.maxSeq(), file: files.info() })
  })

  // The full budget file for a new device, with the log position it already contains.
  router.get('/file', (_req, res) => {
    const file = files.get()
    if (!file) throw new AuthError(404, 'The server has no budget file yet')
    res.set({
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Budget-Cursor': String(file.cursor),
    })
    res.send(Buffer.from(file.bytes))
  })

  router.put(
    '/file',
    express.raw({ type: 'application/octet-stream', limit: MAX_FILE_BYTES }),
    (req, res) => {
      const cursor = Number(req.query.cursor)
      if (!Number.isInteger(cursor) || cursor < 0 || cursor > store.maxSeq()) {
        throw new AuthError(400, 'cursor must be a log position the server has')
      }
      const body: unknown = req.body
      if (!Buffer.isBuffer(body) || !body.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
        throw new AuthError(400, 'The body must be a SQLite database file')
      }
      const user = res.locals.user as { id: string }
      if (!files.put(body, cursor, user.id, new Date(now()).toISOString())) {
        throw new AuthError(409, 'The server already has a newer budget file')
      }
      res.json({ cursor, size: body.length })
    },
  )

  // The server's whole trie, for a device whose own root disagrees after a sync.
  router.get('/trie', (_req, res) => {
    res.json({ trie: store.merkle() })
  })

  // Everything stamped at or after `from`, paged by arrival order; used to repair a divergence.
  router.get('/messages', (req, res) => {
    const from = req.query.from
    const after = Number(req.query.after ?? 0)
    if (typeof from !== 'string' || !ISO_PREFIX.test(from) || from.length > 60) {
      throw new AuthError(400, 'from must be an ISO timestamp')
    }
    if (!Number.isInteger(after) || after < 0) throw new AuthError(400, 'after must be an integer')
    res.json(store.from(from, after))
  })

  return router
}
