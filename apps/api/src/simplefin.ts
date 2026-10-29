import { isIP } from 'node:net'
import { AuthError } from './auth.ts'

/** SimpleFIN refuses a window longer than this. */
export const MAX_WINDOW_DAYS = 90
const REQUEST_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024

export type Fetch = typeof fetch

export interface ExternalTransaction {
  id: string
  /** The day it posted (UTC), as YYYY-MM-DD. */
  posted: string
  /** Integer cents; negative is money out. */
  amount: number
  description: string
}

export interface ExternalAccount {
  id: string
  name: string
  /** The institution, for telling two "Checking" accounts apart. */
  org: string
  currency: string
  /** Integer cents. */
  balance: number
  availableBalance: number | null
  /** When the bank reported the balance, as an ISO timestamp. */
  balanceDate: string | null
  transactions: ExternalTransaction[]
}

export interface FetchResult {
  accounts: ExternalAccount[]
  /** Messages SimpleFIN passes on, such as a bank needing the person to sign in again. */
  messages: string[]
}

export interface FetchOptions {
  /** Epoch seconds. */
  start?: number
  end?: number
  balancesOnly?: boolean
}

/** Only a public https host: the URLs come from a pasted token, and the server fetches them. */
function assertPublicHttps(url: URL, what: string) {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (
    url.protocol !== 'https:' ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    isIP(host)
  ) {
    throw new AuthError(400, `The ${what} must be an https URL on a public hostname`)
  }
}

/**
 * Turns a SimpleFIN setup token into the access URL that holds the credentials. A setup
 * token is the base64 of a claim URL that can be used exactly once.
 */
export async function claimSetupToken(token: string, fetchImpl: Fetch = fetch): Promise<string> {
  let claimUrl: URL
  try {
    claimUrl = new URL(Buffer.from(token.trim(), 'base64').toString('utf8'))
  } catch {
    throw new AuthError(400, 'That is not a SimpleFIN setup token')
  }
  assertPublicHttps(claimUrl, 'setup token')
  const res = await send(fetchImpl, claimUrl, { method: 'POST' })
  if (res.status === 403) {
    throw new AuthError(400, 'SimpleFIN rejected the setup token; it may already have been used')
  }
  if (!res.ok) throw new AuthError(502, `SimpleFIN could not claim the token (${res.status})`)
  const accessUrl = (await readText(res)).trim()
  try {
    assertPublicHttps(new URL(accessUrl), 'access URL')
  } catch {
    throw new AuthError(502, 'SimpleFIN returned something that is not an access URL')
  }
  return accessUrl
}

/** Reads balances and transactions through an access URL. */
export async function fetchAccounts(
  accessUrl: string,
  options: FetchOptions = {},
  fetchImpl: Fetch = fetch,
): Promise<FetchResult> {
  const url = new URL(accessUrl)
  // fetch refuses credentials in the URL, so they travel as a Basic header instead.
  const auth = Buffer.from(
    `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
  ).toString('base64')
  url.username = ''
  url.password = ''
  url.pathname = `${url.pathname.replace(/\/$/, '')}/accounts`
  if (options.start !== undefined) url.searchParams.set('start-date', String(options.start))
  if (options.end !== undefined) url.searchParams.set('end-date', String(options.end))
  if (options.balancesOnly) url.searchParams.set('balances-only', '1')

  const res = await send(fetchImpl, url, { headers: { authorization: `Basic ${auth}` } })
  if (res.status === 402) throw new AuthError(502, 'SimpleFIN says the subscription needs renewing')
  if (res.status === 403) {
    throw new AuthError(502, 'SimpleFIN no longer accepts this connection; link the bank again')
  }
  if (res.status === 429) {
    throw new AuthError(502, 'SimpleFIN rate limit reached (about 24 requests a day); try later')
  }
  if (!res.ok) throw new AuthError(502, `SimpleFIN request failed (${res.status})`)
  let body: unknown
  try {
    body = JSON.parse(await readText(res))
  } catch {
    throw new AuthError(502, 'SimpleFIN returned an unreadable response')
  }
  return parseAccountSet(body)
}

async function send(fetchImpl: Fetch, url: URL, init: RequestInit): Promise<Response> {
  try {
    // A redirect could point the server at an internal address.
    return await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new AuthError(502, 'Could not reach SimpleFIN')
  }
}

async function readText(res: Response): Promise<string> {
  const text = await res.text()
  if (text.length > MAX_RESPONSE_BYTES) throw new AuthError(502, 'SimpleFIN response is too large')
  return text
}

/**
 * Converts a decimal string such as "-12.345" to integer cents, rounding half away from
 * zero. Done on the digits, never through a float.
 */
export function parseCents(value: unknown): number {
  const text = typeof value === 'number' ? String(value) : value
  const match = typeof text === 'string' ? /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim()) : null
  if (!match) throw new Error(`not a decimal amount: ${String(value)}`)
  const [, sign, whole, fraction = ''] = match
  const padded = fraction.padEnd(3, '0')
  let cents = Number(whole) * 100 + Number(padded.slice(0, 2))
  if (Number(padded[2]) >= 5) cents++
  if (!Number.isSafeInteger(cents)) throw new Error(`amount out of range: ${text}`)
  return sign === '-' ? -cents : cents
}

const isoDay = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString().slice(0, 10)

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error(`${what} is not an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${what} is missing`)
  return value
}

function seconds(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${what} is not a timestamp`)
  }
  return value
}

/** Checks and normalizes SimpleFIN's account set (protocol 1.x). */
export function parseAccountSet(body: unknown): FetchResult {
  try {
    const set = record(body, 'response')
    const messages = [
      ...(Array.isArray(set.errors) ? set.errors : []).filter((e) => typeof e === 'string'),
      ...(Array.isArray(set.errlist) ? set.errlist : []).flatMap((e) => {
        const msg = (e as { msg?: unknown } | null)?.msg
        return typeof msg === 'string' ? [msg] : []
      }),
    ] as string[]
    if (!Array.isArray(set.accounts)) throw new Error('accounts is missing')
    const accounts = set.accounts.map((raw): ExternalAccount => {
      const a = record(raw, 'account')
      const org = a.org === undefined ? {} : record(a.org, 'org')
      const balanceDate = a['balance-date']
      const available = a['available-balance']
      return {
        id: text(a.id, 'account id'),
        name: text(a.name, 'account name'),
        org: String(org.name ?? org.domain ?? ''),
        currency: typeof a.currency === 'string' ? a.currency : 'USD',
        balance: parseCents(a.balance),
        availableBalance:
          available === undefined || available === null ? null : parseCents(available),
        balanceDate:
          typeof balanceDate === 'number' && balanceDate > 0
            ? new Date(balanceDate * 1000).toISOString()
            : null,
        // Pending transactions can change amount and id once they post, so they wait.
        transactions: (Array.isArray(a.transactions) ? a.transactions : [])
          .map((rawTx) => record(rawTx, 'transaction'))
          .filter((t) => t.pending !== true)
          .map((t): ExternalTransaction => ({
            id: text(t.id, 'transaction id'),
            posted: isoDay(seconds(t.posted, 'posted')),
            amount: parseCents(t.amount),
            description: typeof t.description === 'string' ? t.description : '',
          })),
      }
    })
    return { accounts, messages }
  } catch (error) {
    throw new AuthError(
      502,
      `SimpleFIN returned data we could not read (${(error as Error).message})`,
    )
  }
}
