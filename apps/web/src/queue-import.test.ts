import type { ImportSummary } from '@budget-fi/core'
import { describe, expect, it } from 'vitest'
import { drainImportQueue } from './queue-import.ts'
import type { QueuedAccount } from './bank.ts'

const account = (id: string, queueIds: number[]): QueuedAccount => ({
  id,
  name: id,
  org: '',
  transactions: queueIds.map((n) => ({
    id: `t${n}`,
    posted: '2026-10-27',
    amount: -100,
    description: 'X',
  })),
  queueIds,
})

const summary = (unmapped: string[] = []): ImportSummary => ({
  added: 1,
  matched: 0,
  alreadyImported: 0,
  dismissed: 0,
  unmapped: unmapped.map((externalId) => ({ externalId, name: externalId, transactions: 1 })),
})

describe('drainImportQueue', () => {
  it('does nothing when the queue is empty', async () => {
    let imported = false
    const result = await drainImportQueue({
      fetchQueue: async () => [],
      importTransactions: async () => ((imported = true), summary()),
      markApplied: async () => {},
    })
    expect(result).toBeNull()
    expect(imported).toBe(false)
  })

  it('hands back everything once the budget has it', async () => {
    const applied: number[][] = []
    await drainImportQueue({
      fetchQueue: async () => [account('A1', [1, 2]), account('A2', [3])],
      importTransactions: async () => summary(),
      markApplied: async (ids) => void applied.push(ids),
    })
    expect(applied).toEqual([[1, 2, 3]])
  })

  it('leaves transactions from an unlinked bank account queued', async () => {
    const applied: number[][] = []
    await drainImportQueue({
      fetchQueue: async () => [account('A1', [1, 2]), account('A2', [3])],
      importTransactions: async () => summary(['A2']),
      markApplied: async (ids) => void applied.push(ids),
    })
    expect(applied).toEqual([[1, 2]])
  })

  it('does not hand anything back if the import fails', async () => {
    const applied: number[][] = []
    await expect(
      drainImportQueue({
        fetchQueue: async () => [account('A1', [1])],
        importTransactions: async () => {
          throw new Error('disk full')
        },
        markApplied: async (ids) => void applied.push(ids),
      }),
    ).rejects.toThrow('disk full')
    expect(applied).toEqual([])
  })
})
