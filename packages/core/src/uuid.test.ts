import { afterEach, expect, it, vi } from 'vitest'
import { randomUuid } from './uuid.ts'

afterEach(() => vi.unstubAllGlobals())

it('makes v4 UUIDs without crypto.randomUUID (insecure contexts)', () => {
  vi.stubGlobal('crypto', {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
  })
  const a = randomUuid()
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(randomUuid()).not.toBe(a)
})
