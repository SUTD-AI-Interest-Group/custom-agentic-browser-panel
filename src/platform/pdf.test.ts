// pdf.ts is Chrome/pdf.js-coupled (dynamic import, workers, DOM canvas) and has
// no test harness for a real render — this environment has no `canvas` native
// binding, so jsdom's getContext('2d') always returns null and a genuine
// render() call can never be reached from a unit test (confirmed by direct
// experiment). planEviction is the one piece of the F2 fix that IS pure: the
// decision of which cache key to evict, given an in-use flag per key. It is
// exported specifically so this defect (an LRU with no concept of "in use")
// stays covered without needing a real pdf.js worker.
import { describe, it, expect } from 'vitest'
import { planEviction } from './pdf'

describe('planEviction', () => {
  it('evicts the oldest key(s) down to max when nothing is in use', () => {
    expect(planEviction(['a', 'b', 'c', 'd'], 3, () => false)).toEqual(['a'])
  })

  it('is a no-op when already at or under max', () => {
    expect(planEviction(['a', 'b', 'c'], 3, () => false)).toEqual([])
    expect(planEviction(['a'], 3, () => false)).toEqual([])
    expect(planEviction([], 3, () => false)).toEqual([])
  })

  it('evicts as many oldest idle keys as needed, not just one', () => {
    expect(planEviction(['a', 'b', 'c', 'd', 'e'], 3, () => false)).toEqual(['a', 'b'])
  })

  it('skips an in-use key and evicts the next-oldest idle one instead — the F2 fix', () => {
    // Reproduces the bug this replaces: an eviction with no concept of "in
    // use" (isInUse always false, i.e. today's actual behavior) picks purely
    // by recency and would destroy 'a' even though a caller still holds it.
    const before = planEviction(['a', 'b', 'c', 'd'], 3, () => false)
    expect(before).toEqual(['a'])

    const inUse = new Set(['a'])
    const after = planEviction(['a', 'b', 'c', 'd'], 3, (k) => inUse.has(k))
    expect(after).toEqual(['b'])
    expect(after).not.toContain('a')
  })

  it('keeps walking past multiple in-use keys to find enough idle ones', () => {
    const inUse = new Set(['a', 'c'])
    const evicted = planEviction(['a', 'b', 'c', 'd', 'e'], 3, (k) => inUse.has(k))
    expect(evicted).toEqual(['b', 'd'])
  })

  it('leaves the cache over max when every entry is in use — safety over strict capacity', () => {
    expect(planEviction(['a', 'b', 'c', 'd'], 3, () => true)).toEqual([])
  })
})
