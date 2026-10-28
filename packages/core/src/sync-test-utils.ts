import { createBudgetApi, type BudgetApi } from './api.ts'
import type { ChangeMessage } from './changes.ts'
import { emptyTrie, insertTimestamp, type TrieNode } from './merkle.ts'
import type { StorageAdapter } from './storage.ts'
import {
  SyncError,
  type RangePage,
  type ServerInfo,
  type SyncRequest,
  type SyncResponse,
  type SyncTransport,
} from './sync.ts'
import { openMemoryAdapter } from './test-utils.ts'

export const A = '0123456789abcdef'
export const B = 'fedcba9876543210'
export const T0 = Date.parse('2026-10-28T12:00:00.000Z')

/** The server's behaviour in memory, close enough to apps/api to exercise the protocol. */
export class FakeServer implements SyncTransport {
  log: { seq: number; message: ChangeMessage }[] = []
  file: { bytes: Uint8Array; cursor: number } | null = null
  uploads = 0
  down = false
  calls = 0

  private build(): TrieNode {
    const t = emptyTrie()
    for (const { message } of this.log) insertTimestamp(t, message.timestamp)
    return t
  }

  async sync(req: SyncRequest): Promise<SyncResponse> {
    this.calls++
    if (this.down) throw new SyncError('Could not reach the server')
    for (const message of req.messages) {
      if (!this.log.some((e) => e.message.timestamp === message.timestamp)) {
        this.log.push({ seq: this.log.length + 1, message })
      }
    }
    const max = this.log.length
    const cursor = Math.min(req.cursor, max)
    const page = this.log.filter((e) => e.seq > cursor).slice(0, 3)
    return {
      messages: page.map((e) => e.message),
      cursor: page.length ? page[page.length - 1]!.seq : cursor,
      hasMore: this.log.filter((e) => e.seq > cursor).length > page.length,
      root: this.build().hash,
      fileCursor: this.file?.cursor ?? null,
    }
  }

  async info(): Promise<ServerInfo> {
    if (this.down) throw new SyncError('Could not reach the server')
    return {
      messages: this.log.length,
      file: this.file && {
        cursor: this.file.cursor,
        size: this.file.bytes.length,
        createdAt: new Date(T0).toISOString(),
      },
    }
  }

  async downloadFile() {
    return this.file
  }

  async uploadFile(bytes: Uint8Array, cursor: number): Promise<void> {
    if (this.down) throw new SyncError('Could not reach the server')
    if (this.file && cursor < this.file.cursor) throw new SyncError('Newer file held', 409)
    this.uploads++
    this.file = { bytes, cursor }
  }

  async trie(): Promise<TrieNode> {
    return this.build()
  }

  async messagesFrom(from: string, after: number): Promise<RangePage> {
    const rows = this.log.filter((e) => e.seq > after && e.message.timestamp >= from)
    const page = rows.slice(0, 2)
    return {
      messages: page.map((e) => e.message),
      next: rows.length > page.length ? page[page.length - 1]!.seq : null,
    }
  }
}
export class Device {
  clock = T0
  readonly adapter: StorageAdapter
  readonly api: BudgetApi
  readonly id: string

  constructor(adapter: StorageAdapter, api: BudgetApi, id: string) {
    this.adapter = adapter
    this.api = api
    this.id = id
  }

  static async create(id: string, server: SyncTransport) {
    const adapter = await openMemoryAdapter()
    let n = 0
    const device: Device = new Device(
      adapter,
      createBudgetApi({
        adapter,
        storage: 'memory',
        sqliteVersion: 'test',
        deviceId: id,
        newId: () => `${id.slice(0, 2)}-${++n}`,
        now: () => new Date(device.clock).toISOString(),
        syncTransport: server,
      }),
      id,
    )
    return device
  }

  async accounts() {
    return this.adapter.query('SELECT id, name, type, closed FROM accounts ORDER BY id')
  }
}
