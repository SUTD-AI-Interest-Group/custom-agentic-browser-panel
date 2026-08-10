import { describe, expect, it } from 'vitest'
import { estimateCost, formatCost, formatTokens, type ModelPrice } from './pricing'

const PRICE: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 }

describe('estimateCost', () => {
  it('bills input, output and cached input at their own rates', () => {
    // 800 uncached in @3, 200 cached @0.3, 500 out @15
    const cost = estimateCost({ inputTokens: 1000, cachedInputTokens: 200, outputTokens: 500 }, PRICE)
    expect(cost).toBeCloseTo((800 * 3 + 200 * 0.3 + 500 * 15) / 1_000_000, 12)
  })

  it('does not double-count cached tokens already inside inputTokens', () => {
    // A fully-cached prompt costs only the cache-read rate. If cached tokens were
    // added ON TOP of inputTokens instead of carved out of them, this would come
    // out at (1000*3 + 1000*0.3)/1e6 — an 11x overstatement.
    const withCache = estimateCost({ inputTokens: 1000, cachedInputTokens: 1000 }, PRICE)
    expect(withCache).toBeCloseTo((1000 * 0.3) / 1_000_000, 12)
  })

  it('clamps a provider reporting more cached than input rather than going negative', () => {
    const cost = estimateCost({ inputTokens: 100, cachedInputTokens: 500 }, PRICE)
    expect(cost).toBeGreaterThanOrEqual(0)
  })

  it('never bills reasoning tokens separately — they are already inside outputTokens', () => {
    const a = estimateCost({ outputTokens: 500 }, PRICE)
    const b = estimateCost({ outputTokens: 500, reasoningTokens: 400 }, PRICE)
    expect(b).toBe(a)
  })

  it('returns undefined when no rate is configured, rather than a misleading zero', () => {
    expect(estimateCost({ inputTokens: 1000, outputTokens: 500 }, {})).toBeUndefined()
  })

  it('prices the half it knows when only one rate is set', () => {
    const cost = estimateCost({ inputTokens: 1000, outputTokens: 500 }, { outputPerMTok: 15 })
    expect(cost).toBeCloseTo((500 * 15) / 1_000_000, 12)
  })

  it('treats a configured rate of 0 as a real price, not as unset', () => {
    // A free local endpoint is a legitimate $0. It must produce 0, not undefined,
    // or the UI would fall back to "no price set" for a model that genuinely costs
    // nothing. This is why the settings UI clears a blank field instead of writing 0.
    expect(estimateCost({ inputTokens: 1000, outputTokens: 500 }, { inputPerMTok: 0, outputPerMTok: 0 })).toBe(0)
  })

  it('returns undefined for an empty usage', () => {
    expect(estimateCost({}, PRICE)).toBeUndefined()
  })

  it('ignores a cached figure with no cached rate rather than billing it as input', () => {
    // Only an input rate is known. The honest reading is that the 200 cached
    // tokens are unpriced, so only the 800 uncached ones are billed — never the
    // full 1000 at the input rate.
    const cost = estimateCost({ inputTokens: 1000, cachedInputTokens: 200 }, { inputPerMTok: 3 })
    expect(cost).toBeCloseTo((800 * 3) / 1_000_000, 12)
  })
})

describe('formatTokens', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatTokens(940)).toBe('940')
    expect(formatTokens(1240)).toBe('1.2k')
    expect(formatTokens(1_240_000)).toBe('1.2M')
  })

  it('drops a trailing .0 so round numbers read cleanly', () => {
    expect(formatTokens(2000)).toBe('2k')
    expect(formatTokens(3_000_000)).toBe('3M')
  })

  it('renders zero as 0', () => {
    expect(formatTokens(0)).toBe('0')
  })
})

describe('formatCost', () => {
  it('keeps small costs legible instead of rounding them to zero', () => {
    expect(formatCost(0.0000043)).toBe('<$0.01')
    expect(formatCost(0.42)).toBe('$0.42')
    expect(formatCost(12.5)).toBe('$12.50')
  })

  it('renders an exact zero as free rather than as "less than a cent"', () => {
    expect(formatCost(0)).toBe('$0.00')
  })
})
