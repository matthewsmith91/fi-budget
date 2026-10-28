export type SqlValue = string | number | null | Uint8Array
export type Row = Record<string, SqlValue>

export interface SqlRunner {
  exec(sql: string, params?: readonly SqlValue[]): Promise<void>
  query<T extends Row = Row>(sql: string, params?: readonly SqlValue[]): Promise<T[]>
}

/**
 * The only way domain code touches the database. The browser worker, the Node
 * tests and (later) the Capacitor app each supply an implementation.
 */
export interface StorageAdapter extends SqlRunner {
  /** Runs `fn` atomically; concurrent callers are serialized. Rolls back if `fn` throws. */
  transaction<T>(fn: (tx: SqlRunner) => Promise<T>, opts?: { foreignKeys?: boolean }): Promise<T>
  /** The whole budget file as a SQLite database image. */
  exportFile(): Promise<Uint8Array>
  /** Replaces the whole budget file with a SQLite database image. */
  importFile(bytes: Uint8Array): Promise<void>
  close(): Promise<void>
}
