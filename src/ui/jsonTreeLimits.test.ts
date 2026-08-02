import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MAX_DEPTH, MAX_ENTRIES, pageEntries, shouldDescend } from './jsonTreeLimits'
import { JSON_MAX } from './blocks'

describe('shouldDescend', () => {
  it('descends below the cap', () => {
    expect(shouldDescend(0)).toBe(true)
    expect(shouldDescend(MAX_DEPTH - 1)).toBe(true)
  })

  it('stops exactly at the cap (boundary)', () => {
    expect(shouldDescend(MAX_DEPTH)).toBe(false)
  })

  it('stops well past the cap', () => {
    expect(shouldDescend(MAX_DEPTH + 1000)).toBe(false)
  })

  it('honors a custom max for callers that want a different bound', () => {
    expect(shouldDescend(3, 3)).toBe(false)
    expect(shouldDescend(2, 3)).toBe(true)
  })

  it('a legitimately-sized (under blocks.ts JSON_MAX) but deeply nested array exceeds MAX_DEPTH — the cap is reachable, not just theoretical', () => {
    // Deepest array nesting achievable within a JSON_MAX-character budget:
    // '[' * n + ']' * n costs exactly 2n characters, no other content needed.
    const deepestPossibleWithinBudget = Math.floor(JSON_MAX / 2)
    expect(deepestPossibleWithinBudget).toBeGreaterThan(MAX_DEPTH)
    // Prove it's actually parseable JSON at that depth, not just arithmetic.
    const n = MAX_DEPTH + 50
    const deep = JSON.parse('['.repeat(n) + ']'.repeat(n))
    let depth = 0
    let cur: unknown = deep
    while (Array.isArray(cur) && cur.length === 1) {
      cur = cur[0]
      depth++
    }
    expect(depth).toBeGreaterThan(MAX_DEPTH)
  })
})

describe('pageEntries', () => {
  it('returns everything unchanged when under the cap', () => {
    const entries = [1, 2, 3]
    expect(pageEntries(entries, 10)).toEqual({ shown: [1, 2, 3], hiddenCount: 0 })
  })

  it('returns everything unchanged exactly at the cap (boundary)', () => {
    const entries = [1, 2, 3]
    expect(pageEntries(entries, 3)).toEqual({ shown: [1, 2, 3], hiddenCount: 0 })
  })

  it('truncates and reports the hidden count when over the cap', () => {
    const entries = [1, 2, 3, 4, 5]
    expect(pageEntries(entries, 3)).toEqual({ shown: [1, 2, 3], hiddenCount: 2 })
  })

  it('defaults to MAX_ENTRIES when no max is given', () => {
    const entries = Array.from({ length: MAX_ENTRIES + 25 }, (_, i) => i)
    const { shown, hiddenCount } = pageEntries(entries)
    expect(shown.length).toBe(MAX_ENTRIES)
    expect(hiddenCount).toBe(25)
  })

  it('handles an empty array', () => {
    expect(pageEntries([])).toEqual({ shown: [], hiddenCount: 0 })
  })
})

// Integration guard: JsonTree.tsx must actually use these bounds, not just
// leave them defined and unused. Untestable end-to-end under jsdom+vitest
// without rendering a real React tree deep enough to overflow the call
// stack in-process (which would crash the test worker, not just fail an
// assertion) — so, like other DOM/React-coupled invariants in this codebase,
// this is a source-scan plus a manual /verify-extension check.
describe('JsonTree wires the depth/entry caps into its recursive render', () => {
  const HERE = fileURLToPath(import.meta.url)
  const SRC = readFileSync(join(dirname(HERE), 'JsonTree.tsx'), 'utf-8')

  it('imports and calls shouldDescend and pageEntries', () => {
    expect(SRC).toMatch(/shouldDescend/)
    expect(SRC).toMatch(/pageEntries/)
  })
})
