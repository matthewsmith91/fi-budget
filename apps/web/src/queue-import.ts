import type { ImportAccount, ImportSummary } from '@budget-fi/core'
import type { QueuedAccount } from './bank.ts'

export interface QueueDeps {
  fetchQueue(): Promise<QueuedAccount[]>
  importTransactions(accounts: ImportAccount[]): Promise<ImportSummary>
  markApplied(ids: number[]): Promise<void>
}

/**
 * Takes what the server's daily pull has fetched into the budget. Transactions from a bank
 * account that is not linked yet stay queued, so linking it later still brings them in;
 * everything else is handed back as done once the budget has it.
 */
export async function drainImportQueue(deps: QueueDeps): Promise<ImportSummary | null> {
  const accounts = await deps.fetchQueue()
  if (accounts.length === 0) return null
  const summary = await deps.importTransactions(accounts)
  const waiting = new Set(summary.unmapped.map((u) => u.externalId))
  const done = accounts.filter((a) => !waiting.has(a.id)).flatMap((a) => a.queueIds)
  if (done.length > 0) await deps.markApplied(done)
  return summary
}
