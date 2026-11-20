import { describe, expect, it } from 'vitest'
import { compareVersions, justUpdated } from './update.ts'

describe('compareVersions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('0.10.0', '0.9.3')).toBe(1)
    expect(compareVersions('1.2.11', '1.3.0')).toBe(-1)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
  })
  it('ignores build metadata', () => {
    expect(compareVersions('1.2.3+2026-11-10', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.4+abc', '1.2.3')).toBe(1)
  })
  it('puts a pre-release before its release', () => {
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBe(-1)
    expect(compareVersions('1.2.0', '1.2.0-beta.1')).toBe(1)
    expect(compareVersions('1.2.0-beta.1', '1.2.0-beta.2')).toBe(-1)
    expect(compareVersions('1.2.0-beta.1', '1.1.9')).toBe(1)
  })
  it('never treats a malformed version as newer', () => {
    expect(compareVersions('latest', '0.1.0')).toBe(-1)
    expect(compareVersions('0.1.0', 'nightly')).toBe(1)
  })
})

describe('justUpdated', () => {
  it('is true only after moving to a newer version', () => {
    expect(justUpdated(null, '0.1.0')).toBe(false)
    expect(justUpdated('0.1.0', '0.1.0')).toBe(false)
    expect(justUpdated('0.1.0', '0.2.0')).toBe(true)
    expect(justUpdated('0.2.0', '0.1.0')).toBe(false)
  })
})
