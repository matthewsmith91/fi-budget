import type { DatabaseSync } from 'node:sqlite'
import { AuthError } from './auth.ts'
import { open } from './bank.ts'
import { MAX_WINDOW_DAYS, fetchAccounts, type Fetch } from './simplefin.ts'

const HOUR_MS = 60 * 60 * 1000
const DAY_SECONDS = 24 * 60 * 60
/** One request a day per link is far inside SimpleFIN's limit of about 24. */
export const PULL_EVERY_MS = 24 * HOUR_MS
/** After a failure, try again sooner than a day but not in a tight loop. */
export const RETRY_AFTER_ERROR_MS = 6 * HOUR_MS
/** The first pull reaches this far back. */
export const FIRST_PULL_DAYS = 30
/** Each pull re-reads this many days before the last one, so a late-posting transaction is not missed. */
export const OVERLAP_DAYS = 3
/** Queue rows older than this are dropped, applied or not. */
const KEEP_DAYS = 100

export interface PullDeps {
  db: DatabaseSync
  key: Buffer
  now?: () => number
  fetch?: Fetch
}

interface LinkRow {
  id: string
  access_token: string
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`)

export interface PullResult {
  linkId: string
  ok: boolean
  /** Transactions not seen before. */
  queued: number
  error?: string
}

/** Fetches one link's recent transactions into the queue. Never throws: the outcome is recorded. */
export async function pullLink(
  { db, key, now = Date.now, fetch: fetchImpl }: PullDeps,
  link: LinkRow,
): Promise<PullResult> {
  const at = now()
  const today = day(at)
  const cursor = (
    db.prepare('SELECT cursor FROM sync_cursors WHERE link_id = ?').get(link.id) as
      { cursor: string | null } | undefined
  )?.cursor
  const earliest = at / 1000 - (MAX_WINDOW_DAYS - 1) * DAY_SECONDS
  const wanted = cursor
    ? dayMs(cursor) / 1000 - OVERLAP_DAYS * DAY_SECONDS
    : dayMs(today) / 1000 - (FIRST_PULL_DAYS - 1) * DAY_SECONDS
  const record = db.prepare(
    `INSERT INTO sync_cursors (link_id, cursor, last_run, last_error) VALUES (?, ?, ?, ?)
     ON CONFLICT (link_id) DO UPDATE SET cursor = excluded.cursor,
       last_run = excluded.last_run, last_error = excluded.last_error`,
  )
  try {
    const { accounts } = await fetchAccounts(
      open(link.access_token, key),
      { start: Math.max(wanted, earliest), end: at / 1000 },
      fetchImpl,
    )
    const fetchedAt = new Date(at).toISOString()
    const insert = db.prepare(
      `INSERT OR IGNORE INTO import_queue
         (link_id, account_external_id, account_name, account_org, transaction_id,
          posted, amount, description, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    let queued = 0
    db.exec('BEGIN')
    try {
      for (const account of accounts) {
        for (const t of account.transactions) {
          const { changes } = insert.run(
            link.id,
            account.id,
            account.name,
            account.org,
            t.id,
            t.posted,
            t.amount,
            t.description,
            fetchedAt,
          )
          queued += Number(changes)
        }
      }
      record.run(link.id, today, fetchedAt, null)
      db.prepare('UPDATE bank_links SET last_fetched_at = ? WHERE id = ?').run(fetchedAt, link.id)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { linkId: link.id, ok: true, queued }
  } catch (error) {
    const known = error instanceof AuthError
    if (!known) console.error('daily bank pull failed', error)
    const message = known ? error.message : 'Could not read this bank link'
    record.run(link.id, cursor ?? null, new Date(at).toISOString(), message)
    return { linkId: link.id, ok: false, queued: 0, error: message }
  }
}

/** Links whose last pull is a day old (or six hours, after a failure), or that were never pulled. */
export function dueLinks(db: DatabaseSync, nowMs: number): LinkRow[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.access_token, c.last_run, c.last_error
       FROM bank_links l LEFT JOIN sync_cursors c ON c.link_id = l.id
       ORDER BY l.created_at, l.id`,
    )
    .all() as unknown as (LinkRow & { last_run: string | null; last_error: string | null })[]
  return rows.filter((r) => {
    if (r.last_run === null) return true
    const wait = r.last_error === null ? PULL_EVERY_MS : RETRY_AFTER_ERROR_MS
    return nowMs - Date.parse(r.last_run) >= wait
  })
}

export async function runDuePulls(deps: PullDeps): Promise<PullResult[]> {
  const nowMs = (deps.now ?? Date.now)()
  const results: PullResult[] = []
  for (const link of dueLinks(deps.db, nowMs)) results.push(await pullLink(deps, link))
  deps.db
    .prepare('DELETE FROM import_queue WHERE fetched_at < ?')
    .run(new Date(nowMs - KEEP_DAYS * DAY_SECONDS * 1000).toISOString())
  return results
}

/** Checks for due links every half hour (and once now); returns a function that stops it. */
export function startDailyPulls(deps: PullDeps, intervalMs = HOUR_MS / 2): () => void {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await runDuePulls(deps)
    } catch (error) {
      console.error('daily bank pull failed', error)
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
