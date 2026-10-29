/** "KROGER #123 ATLANTA GA" → "KROGER": the words before the first one with a digit, at most three. */
export function ruleTextFor(payee: string): string {
  const words = payee.split(/[^A-Za-z0-9]+/).filter(Boolean)
  const end = words.findIndex((w) => /\d/.test(w))
  return (end === -1 ? words : words.slice(0, end)).slice(0, 3).join(' ') || payee
}
