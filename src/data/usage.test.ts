import { describe, expect, it } from 'vitest'
import { estimateBytes, formatBytes, planPrune } from './usage'

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

// Shared eviction policy behind screenshots.ts/mcpArtifacts.ts's (age + byte
// cap) and artifacts.ts's (byte cap only) pruning. row() below uses `recency`
// as a stand-in for whichever timestamp field a given store prunes by
// (createdAt for shots/mcp artifacts, updatedAt for code artifacts).
describe('planPrune', () => {
  function row(id: string, bytes: number, recency: number) {
    return { id, bytes, recency }
  }

  it('evicts nothing under the cap', () => {
    expect(planPrune([row('a', 100, 1), row('b', 100, 2)], { maxTotalBytes: 1000 })).toEqual([])
  })

  it('evicts oldest first until under the byte cap', () => {
    const rows = [row('new', 400, 30), row('old', 400, 10), row('mid', 400, 20)]
    expect(planPrune(rows, { maxTotalBytes: 900 })).toEqual(['old'])
    expect(planPrune(rows, { maxTotalBytes: 500 })).toEqual(['old', 'mid'])
  })

  it('never evicts a single surviving row even when it alone busts the byte cap', () => {
    // This is the guard screenshots.ts/mcpArtifacts.ts were missing (F4): a
    // freshly-saved oversized row must not be deleted in the very next prune.
    expect(planPrune([row('only', 5000, 1)], { maxTotalBytes: 1000 })).toEqual([])
    // But with a newer sibling present, the older oversized one still goes.
    expect(
      planPrune([row('huge-old', 5000, 1), row('small-new', 10, 2)], { maxTotalBytes: 1000 }),
    ).toEqual(['huge-old'])
  })

  it('evicts anything past maxAgeMs regardless of the byte cap', () => {
    const now = 100_000
    const rows = [row('ancient', 10, 0), row('recent', 10, now - 10)]
    expect(planPrune(rows, { maxTotalBytes: 1_000_000, maxAgeMs: 1000, now })).toEqual(['ancient'])
  })

  it('age eviction can empty the store even down to the last row — only the byte-cap guard protects a lone survivor', () => {
    const now = 100_000
    expect(planPrune([row('ancient', 10, 0)], { maxTotalBytes: 1_000_000, maxAgeMs: 1000, now })).toEqual([
      'ancient',
    ])
  })

  it('applies the byte cap only to rows that survive age eviction, still protecting the single newest survivor', () => {
    const now = 100_000
    const rows = [row('ancient-huge', 5000, 0), row('fresh-huge', 5000, now)]
    // 'ancient-huge' ages out first; 'fresh-huge' is the lone survivor and busts
    // the cap alone, but must not be evicted by the byte-cap pass.
    expect(planPrune(rows, { maxTotalBytes: 1000, maxAgeMs: 1000, now })).toEqual(['ancient-huge'])
  })
})
