import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Router } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { AuthError } from './auth.ts'
import { requireUser, sessionMiddleware } from './auth-routes.ts'
import {
  MAX_WINDOW_DAYS,
  claimSetupToken,
  fetchAccounts,
  type ExternalAccount,
  type Fetch,
} from './simplefin.ts'

export const KEY_FILE = 'bank.key'
const KEY_BYTES = 32
const DAY_SECONDS = 24 * 60 * 60
/** The most queue rows one request hands out or takes back. */
const QUEUE_PAGE = 2000

/**
 * The key that seals bank access URLs. `BANK_KEY` (base64, 32 bytes) wins; otherwise a key
 * file is made beside the database on first start. A stolen database or backup then does
 * not hand over the bank connection, but a stolen data volume still does: set `BANK_KEY`
 * from the host's secrets to keep the two apart.
 */
export function loadBankKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  if (env.BANK_KEY) {
    const key = Buffer.from(env.BANK_KEY, 'base64')
    if (key.length !== KEY_BYTES) throw new Error('BANK_KEY must be 32 bytes, base64-encoded')
    return key
  }
  const file = `${dataDir}/${KEY_FILE}`
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
    if (key.length !== KEY_BYTES) throw new Error(`${file} does not hold a 32-byte key`)
    return key
  }
  const key = randomBytes(KEY_BYTES)
  writeFileSync(file, key.toString('base64'), { mode: 0o600 })
  chmodSync(file, 0o600)
  return key
}

/** AES-256-GCM; the stored form is `v1:` + base64(iv | tag | ciphertext). */
export function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`
}

export function open(sealed: string, key: Buffer): string {
  if (!sealed.startsWith('v1:')) throw new Error('unknown secret format')
  const raw = Buffer.from(sealed.slice(3), 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}

export interface BankLink {
  id: string
  provider: string
  createdAt: string
  createdBy: string | null
  lastFetchedAt: string | null
  /** When the daily pull last ran, and why it failed if it did. */
  lastPullAt: string | null
  pullError: string | null
  /** Transactions fetched by the daily pull that no device has taken in yet. */
  queued: number
}

interface LinkRow {
  id: string
  provider: string
  access_token: string
  created_at: string
  created_by: string | null
  last_fetched_at: string | null
  pull_run?: string | null
  pull_error?: string | null
  queued?: number
}

const toLink = (row: LinkRow): BankLink => ({
  id: row.id,
  provider: row.provider,
  createdAt: row.created_at,
  createdBy: row.created_by,
  lastFetchedAt: row.last_fetched_at,
  lastPullAt: row.pull_run ?? null,
  pullError: row.pull_error ?? null,
  queued: row.queued ?? 0,
})

export interface BankDeps {
  db: DatabaseSync
  key: Buffer
  /** Injectable clock, in epoch milliseconds. */
  now?: () => number
  /** Injectable network, so tests never reach SimpleFIN. */
  fetch?: Fetch
}

export type LinkFetch =
  | { linkId: string; ok: true; accounts: ExternalAccount[]; messages: string[] }
  | { linkId: string; ok: false; error: string }

/**
 * Bank connections. The access URL is the credential: it is sealed in the database and
 * never leaves the server, so devices ask this proxy for balances and transactions
 * instead of talking to SimpleFIN themselves.
 */
export function createBankRouter({ db, key, now = Date.now, fetch: fetchImpl }: BankDeps): Router {
  const router = Router()
  router.use(sessionMiddleware({ db, now }), requireUser)

  const rows = () =>
    db
      .prepare(
        `SELECT l.*, c.last_run AS pull_run, c.last_error AS pull_error,
           (SELECT COUNT(*) FROM import_queue q WHERE q.link_id = l.id AND q.applied_at IS NULL) AS queued
         FROM bank_links l LEFT JOIN sync_cursors c ON c.link_id = l.id
         ORDER BY l.created_at, l.id`,
      )
      .all() as unknown as LinkRow[]

  router.get('/links', (_req, res) => {
    res.json({ links: rows().map(toLink) })
  })

  // Trades a one-time SimpleFIN setup token for an access URL and keeps it.
  router.post('/links', async (req, res) => {
    const token = (req.body as { setupToken?: unknown } | undefined)?.setupToken
    if (typeof token !== 'string' || token.trim() === '') {
      throw new AuthError(400, 'setupToken is required')
    }
    const accessUrl = await claimSetupToken(token, fetchImpl)
    const user = res.locals.user as { id: string }
    const row: LinkRow = {
      id: randomUUID(),
      provider: 'simplefin',
      access_token: seal(accessUrl, key),
      created_at: new Date(now()).toISOString(),
      created_by: user.id,
      last_fetched_at: null,
    }
    db.prepare(
      'INSERT INTO bank_links (id, provider, access_token, created_at, created_by) VALUES (?, ?, ?, ?, ?)',
    ).run(row.id, row.provider, row.access_token, row.created_at, row.created_by)
    res.status(201).json(toLink(row))
  })

  router.delete('/links/:id', (req, res) => {
    const { changes } = db.prepare('DELETE FROM bank_links WHERE id = ?').run(req.params.id)
    if (changes === 0) throw new AuthError(404, 'No such bank link')
    res.status(204).end()
  })

  // Fetches balances and transactions from every link (or one), a window of at most 90 days.
  // One bank failing is reported beside the others rather than failing the request.
  router.post('/fetch', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const options = parseWindow(body, now())
    const links = rows().filter((row) => body.linkId === undefined || row.id === body.linkId)
    if (body.linkId !== undefined && links.length === 0)
      throw new AuthError(404, 'No such bank link')

    const results: LinkFetch[] = []
    for (const row of links) {
      try {
        const { accounts, messages } = await fetchAccounts(
          open(row.access_token, key),
          options,
          fetchImpl,
        )
        db.prepare('UPDATE bank_links SET last_fetched_at = ? WHERE id = ?').run(
          new Date(now()).toISOString(),
          row.id,
        )
        results.push({ linkId: row.id, ok: true, accounts, messages })
      } catch (error) {
        const known = error instanceof AuthError
        if (!known) console.error('bank fetch failed', error)
        results.push({
          linkId: row.id,
          ok: false,
          error: known ? error.message : 'Could not read this bank link',
        })
      }
    }
    res.json({ results })
  })

  // What the daily pull has fetched and no device has taken in yet, grouped by bank account in
  // the shape `importTransactions` takes. `ids` is what to hand back to /queue/applied.
  router.get('/queue', (_req, res) => {
    const waiting = db
      .prepare(
        `SELECT id, account_external_id, account_name, account_org, transaction_id, posted, amount, description
         FROM import_queue WHERE applied_at IS NULL ORDER BY id LIMIT ?`,
      )
      .all(QUEUE_PAGE) as unknown as {
      id: number
      account_external_id: string
      account_name: string
      account_org: string
      transaction_id: string
      posted: string
      amount: number
      description: string
    }[]
    const accounts = new Map<
      string,
      {
        id: string
        name: string
        org: string
        transactions: { id: string; posted: string; amount: number; description: string }[]
        queueIds: number[]
      }
    >()
    for (const r of waiting) {
      const account = accounts.get(r.account_external_id) ?? {
        id: r.account_external_id,
        name: r.account_name,
        org: r.account_org,
        transactions: [],
        queueIds: [],
      }
      account.transactions.push({
        id: r.transaction_id,
        posted: r.posted,
        amount: r.amount,
        description: r.description,
      })
      account.queueIds.push(r.id)
      accounts.set(r.account_external_id, account)
    }
    res.json({ accounts: [...accounts.values()] })
  })

  router.post('/queue/applied', (req, res) => {
    const ids = (req.body as { ids?: unknown } | undefined)?.ids
    if (
      !Array.isArray(ids) ||
      ids.length > QUEUE_PAGE ||
      !ids.every((id) => Number.isSafeInteger(id))
    ) {
      throw new AuthError(400, 'ids must be a list of queue ids')
    }
    const mark = db.prepare(
      'UPDATE import_queue SET applied_at = ? WHERE id = ? AND applied_at IS NULL',
    )
    const at = new Date(now()).toISOString()
    db.exec('BEGIN')
    try {
      for (const id of ids as number[]) mark.run(at, id)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    res.status(204).end()
  })

  return router
}

/** `startDate` / `endDate` as YYYY-MM-DD (the end day included); defaults to the last 30 days. */
function parseWindow(body: Record<string, unknown>, nowMs: number) {
  const day = (value: unknown, what: string): number => {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) {
      throw new AuthError(400, `${what} must be a YYYY-MM-DD date`)
    }
    const ms = Date.parse(`${value}T00:00:00Z`)
    if (Number.isNaN(ms)) throw new AuthError(400, `${what} must be a YYYY-MM-DD date`)
    return ms / 1000
  }
  const balancesOnly = body.balancesOnly === true
  if (balancesOnly) return { balancesOnly }
  const nowSeconds = Math.floor(nowMs / 1000)
  // SimpleFIN's end date is exclusive, so the last day asked for is covered by the next midnight.
  const end = body.endDate === undefined ? nowSeconds : day(body.endDate, 'endDate') + DAY_SECONDS
  const start =
    body.startDate === undefined ? end - 30 * DAY_SECONDS : day(body.startDate, 'startDate')
  if (start >= end) throw new AuthError(400, 'startDate must be before endDate')
  if (end - start > MAX_WINDOW_DAYS * DAY_SECONDS) {
    throw new AuthError(400, `The window can be at most ${MAX_WINDOW_DAYS} days`)
  }
  return { start, end, balancesOnly }
}
