import { describe, expect, it } from 'vitest'
import { createLatestRequest } from './latestRequest'

describe('createLatestRequest', () => {
  it('keeps a lone in-flight request', () => {
    const seq = createLatestRequest()
    const token = seq.next()
    expect(seq.isStale(token)).toBe(false)
  })

  // The regression: two keystrokes, the FIRST resolving last. Without the
  // guard, the slower older lookup overwrote the newer query's candidates.
  it('marks an older request stale once a newer one is issued', () => {
    const seq = createLatestRequest()
    const first = seq.next()
    const second = seq.next()
    expect(seq.isStale(first)).toBe(true)
    expect(seq.isStale(second)).toBe(false)
  })

  it('keeps only the newest across a burst of typing', () => {
    const seq = createLatestRequest()
    const tokens = [seq.next(), seq.next(), seq.next(), seq.next()]
    expect(tokens.map(seq.isStale)).toEqual([true, true, true, false])
  })

  it('gives each sequence its own counter, so one menu cannot invalidate another', () => {
    const mentions = createLatestRequest()
    const slash = createLatestRequest()
    const m = mentions.next()
    slash.next()
    slash.next()
    expect(mentions.isStale(m)).toBe(false)
  })
})
