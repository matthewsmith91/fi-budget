export const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
