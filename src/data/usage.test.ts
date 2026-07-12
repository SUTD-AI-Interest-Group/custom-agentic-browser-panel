import { describe, expect, it } from 'vitest'
import { estimateBytes, formatBytes } from './usage'

describe('estimateBytes', () => {
  it('counts a string by its length', () => {
    expect(estimateBytes('hello')).toBe(5)
  })

  it('counts nothing for null and undefined', () => {
    expect(estimateBytes(null)).toBe(0)
    expect(estimateBytes(undefined)).toBe(0)
  })

  it('counts object keys as well as their values', () => {
    // 'id'(2) + 'ab'(2) + 'body'(4) + 'xyz'(3) = 11
    expect(estimateBytes({ id: 'ab', body: 'xyz' })).toBe(11)
  })

  it('sums arrays element-wise', () => {
    expect(estimateBytes(['a', 'bb', 'ccc'])).toBe(6)
  })

  it('recurses into nested records', () => {
    // 'a'(1) + 'b'(1) + 'cd'(2) = 4
    expect(estimateBytes({ a: { b: 'cd' } })).toBe(4)
  })

  it('gives numbers and booleans fixed widths', () => {
    expect(estimateBytes(42)).toBe(8)
    expect(estimateBytes(true)).toBe(4)
  })

  it('measures a data URL at roughly its character count — the case that matters', () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(1000)}`
    expect(estimateBytes({ dataUrl })).toBeGreaterThan(1000)
    expect(estimateBytes({ dataUrl })).toBeLessThan(1040)
  })
})

describe('formatBytes', () => {
  it('renders bytes, KB, MB and GB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })
})
