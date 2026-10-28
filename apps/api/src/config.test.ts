import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

describe('loadConfig', () => {
  it('defaults to port 3001 with absolute paths', () => {
    const config = loadConfig({})
    expect(config.port).toBe(3001)
    expect(isAbsolute(config.dataDir)).toBe(true)
    expect(config.staticDir.endsWith('web/dist')).toBe(true)
  })

  it('reads PORT, DATA_DIR and STATIC_DIR', () => {
    const config = loadConfig({ PORT: '8080', DATA_DIR: '/data', STATIC_DIR: '/srv/app' })
    expect(config).toMatchObject({ port: 8080, dataDir: '/data', staticDir: '/srv/app' })
  })

  it('rejects a bad PORT', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/)
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/)
  })

  it('defaults to the local dev origins with a localhost RP ID', () => {
    const config = loadConfig({ PORT: '4000' })
    expect(config.origins).toEqual(['http://localhost:5173', 'http://localhost:4000'])
    expect(config.rpId).toBe('localhost')
  })

  it('takes the RP ID from ORIGIN', () => {
    const config = loadConfig({ ORIGIN: 'https://budget.example.com/' })
    expect(config.origins).toEqual(['https://budget.example.com'])
    expect(config.rpId).toBe('budget.example.com')
  })

  it('rejects an insecure or malformed ORIGIN', () => {
    expect(() => loadConfig({ ORIGIN: 'http://budget.example.com' })).toThrow(/https/)
    expect(() => loadConfig({ ORIGIN: 'budget.example.com' })).toThrow(/ORIGIN/)
    expect(() => loadConfig({ ORIGIN: 'https://a.example.com,https://b.example.com' })).toThrow(
      /hostname/,
    )
  })
})
