import type { StorageAdapter } from './storage.ts'

export interface CrudDeps {
  adapter: StorageAdapter
  newId: () => string
  now: () => string
}

export function cleanName(input: string, what: string): string {
  const name = input.trim()
  if (!name) throw new Error(`${what} name is required`)
  return name
}

export const flag = (b: boolean) => (b ? 1 : 0)

/** Ids to reorder must be exactly the ids currently in scope, each once. */
export function assertSameIds(given: readonly string[], existing: readonly string[], what: string) {
  const want = new Set(existing)
  if (
    given.length !== want.size ||
    new Set(given).size !== want.size ||
    !given.every((id) => want.has(id))
  ) {
    throw new Error(`Reorder must list every ${what} exactly once`)
  }
}
