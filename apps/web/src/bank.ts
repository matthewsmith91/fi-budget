import { request } from './server.ts'

export interface BankLink {
  id: string
  provider: string
  createdAt: string
  lastFetchedAt: string | null
  /** The server's daily pull: when it last ran, why it failed, and what is waiting for a device. */
  lastPullAt: string | null
  pullError: string | null
  queued: number
}

/** What the daily pull has fetched, by bank account; `queueIds` go back to `markApplied`. */
export interface QueuedAccount {
  id: string
  name: string
  org: string
  transactions: { id: string; posted: string; amount: number; description: string }[]
  queueIds: number[]
}

/** Amounts are integer cents; negative is money out. */
export interface ExternalAccount {
  id: string
  name: string
  org: string
  currency: string
  balance: number
  balanceDate: string | null
  transactions: { id: string; posted: string; amount: number; description: string }[]
}

export type LinkFetch =
  | { linkId: string; ok: true; accounts: ExternalAccount[]; messages: string[] }
  | { linkId: string; ok: false; error: string }

/** The server holds the SimpleFIN credential; devices only ever see links and the data fetched. */
export const bankApi = {
  links: async () => (await request<{ links: BankLink[] }>('/api/bank/links')).links,
  link: (setupToken: string) => request<BankLink>('/api/bank/links', { setupToken }),
  unlink: (id: string) =>
    request<void>(`/api/bank/links/${encodeURIComponent(id)}`, undefined, 'DELETE'),
  queue: async () => (await request<{ accounts: QueuedAccount[] }>('/api/bank/queue')).accounts,
  markApplied: (ids: number[]) => request<void>('/api/bank/queue/applied', { ids }),
  /** Balances only: one cheap request, and SimpleFIN allows about 24 a day. */
  checkBalances: async (linkId: string) =>
    (await request<{ results: LinkFetch[] }>('/api/bank/fetch', { linkId, balancesOnly: true }))
      .results[0]!,
  /** The last `days` days (at most 90) of transactions, today included. */
  fetchTransactions: async (linkId: string, days: number, today = new Date()) => {
    const end = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    return (
      await request<{ results: LinkFetch[] }>('/api/bank/fetch', {
        linkId,
        startDate: day(end - (days - 1) * 86_400_000),
        endDate: day(end),
      })
    ).results[0]!
  },
}
