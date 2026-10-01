import { describe, it, expect } from 'vitest'
import golden from './__fixtures__/von-golden.json'
import { FAST_BUCKETS, bucketFor, buildFastInputs, calibrate, marginConfidence, packPrompt, planSequence, VonInputError } from './von'

describe('fast inputs', () => {
  const cfg = { padTokenId: 50283, slidingWindow: 64, headDim: 64, rope: { full: 160000, sliding: 10000 } }
  // [CLS] a b [SEP] [MASK] o1 [MASK] o2 [SEP]: markers at 4 and 6; the trailing [SEP] (row 8) is prefix-class
  const MASK = 50284
  const ids = [50281, 11, 12, 50282, MASK, 21, MASK, 22, 50282]
  const plan = planSequence(ids, MASK, 4096)
  const f = buildFastInputs(ids, plan, cfg)
  const T = f.T
  const bias = (b: Float32Array, i: number, j: number) => b[i * T + j]
  it('buckets to the next size and pads with the pad token', () => {
    expect(FAST_BUCKETS[0]).toBe(256)
    expect(T).toBe(256)
    expect(f.ids.length).toBe(256)
    expect(f.ids.slice(0, 9)).toEqual(ids)
    expect(f.ids[9]).toBe(50283)
    expect(f.cosFull.length).toBe(256 * 64)
    expect(f.biasFull.length).toBe(256 * 256)
  })
  it('keeps the mask rules: prefix↔prefix, option→prefix ∪ own span, diagonal, never a pad', () => {
    expect(bias(f.biasFull, 0, 3)).toBe(0) // prefix sees prefix
    expect(bias(f.biasFull, 4, 0)).toBe(0) // option 0 sees the prefix
    expect(bias(f.biasFull, 4, 5)).toBe(0) // and its own span
    expect(bias(f.biasFull, 4, 6)).toBe(-30000) // never the other option
    expect(bias(f.biasFull, 0, 4)).toBe(-30000) // the prefix never sees an option
    expect(bias(f.biasFull, 8, 4)).toBe(-30000) // the trailing [SEP] is prefix-class
    expect(bias(f.biasFull, 0, 9)).toBe(-30000) // a pad is never a key for a real row
    expect(bias(f.biasFull, 4, 200)).toBe(-30000)
    expect(bias(f.biasFull, 9, 9)).toBe(0) // a pad still sees itself: no empty softmax row
    expect(bias(f.biasFull, 7, 7)).toBe(0)
  })
  it('sliding adds the |Δposition| ≤ window rule on the RESET position ids', () => {
    const far = Array.from({ length: 200 }, (_, i) => 100 + i)
    const ids2 = [50281, ...far.slice(0, 80), 50282, MASK, ...far.slice(80), 50282]
    const p2 = planSequence(ids2, MASK, 4096)
    const g = buildFastInputs(ids2, p2, cfg)
    const i = p2.markers[0] // 82: the marker's position is 82, prefix token 0 is 82 positions back
    expect(g.biasFull[i * g.T + 0]).toBe(0)
    expect(g.biasSliding[i * g.T + 0]).toBe(-30000)
    expect(g.biasSliding[i * g.T + (i - 64)]).toBe(0)
    expect(g.biasSliding[i * g.T + (i - 65)]).toBe(-30000)
  })
  it('indexes the RoPE tables by reset position id, with cat(freqs, freqs) and the right thetas', () => {
    const row = (t: Float32Array, r: number) => Array.from(t.slice(r * 64, r * 64 + 64))
    expect(plan.positionIds[6]).toBe(4) // option 1's marker restarts at the prefix length, like option 0's
    expect(row(f.cosFull, 6)).toEqual(row(f.cosFull, 4))
    expect(row(f.cosFull, 4)[0]).toBeCloseTo(Math.cos(4), 5)
    expect(row(f.cosFull, 4)[32]).toBeCloseTo(Math.cos(4), 5)
    expect(row(f.cosFull, 4)[1]).toBeCloseTo(Math.cos(4 * Math.pow(160000, -2 / 64)), 5)
    expect(row(f.cosSliding, 4)[1]).toBeCloseTo(Math.cos(4 * Math.pow(10000, -2 / 64)), 5)
    expect(row(f.sinFull, 4)[0]).toBeCloseTo(Math.sin(4), 5)
    expect(row(f.cosFull, 9)[0]).toBe(1) // a pad sits at position 0
  })
  it('buckets exactly at a boundary and refuses past the last bucket', () => {
    expect(bucketFor(256, 4096)).toBe(256)
    expect(bucketFor(257, 4096)).toBe(512)
    expect(bucketFor(4096, 4096)).toBe(4096)
    expect(() => bucketFor(4097, 4096)).toThrow(VonInputError)
  })
})

const MASK = golden.maskTokenId

describe('packPrompt', () => {
  it('matches Von pack_sequence byte-for-byte on the golden cases', () => {
    for (const c of golden.cases) {
      expect(packPrompt(c.state, c.instructions, c.options, false)).toBe(c.packed)
    }
  })
  it('splits digit runs when digitSplit is on', () => {
    expect(packPrompt('year 2026', '', ['x'], true)).toBe('year 2 0 2 6 [SEP] [MASK] x')
  })
})

describe('planSequence', () => {
  it('reproduces Python option ids, position ids and markers', () => {
    for (const c of golden.cases) {
      const p = planSequence(c.ids, MASK, 4096)
      expect(p.markers).toEqual(c.markers)
      expect(p.optionIds).toEqual(c.optionIds)
      expect(p.positionIds).toEqual(c.positionIds)
    }
  })
  it('keeps the trailing [SEP] prefix-class at its raw position', () => {
    const ids = [1, 7, 8, 2, MASK, 9, MASK, 10, 11, 2]
    const p = planSequence(ids, MASK, 4096)
    expect(p.optionIds).toEqual([-1, -1, -1, -1, 0, 0, 1, 1, 1, -1])
    expect(p.positionIds).toEqual([0, 1, 2, 3, 4, 5, 4, 5, 6, 9])
  })
  it('gives every option the same start position regardless of slot (order invariance)', () => {
    const ids = [1, 5, 2, MASK, 9, 9, 9, MASK, 8, 2]
    const p = planSequence(ids, MASK, 4096)
    expect(p.positionIds[p.markers[0]]).toBe(p.positionIds[p.markers[1]])
  })
  it('rejects over-length input instead of truncating', () => {
    const ids = [1, MASK, ...Array(5000).fill(3), 2]
    expect(() => planSequence(ids, MASK, 4096)).toThrow(VonInputError)
  })
  it('rejects a sequence with no options', () => {
    expect(() => planSequence([1, 3, 2], MASK, 4096)).toThrow(VonInputError)
  })
})

describe('calibrate', () => {
  it('matches Python calibrated probabilities on the golden cases', () => {
    for (const c of golden.cases) {
      const got = calibrate(c.logits, c.stateTokens, golden.calibration)
      got.forEach((p, i) => expect(p).toBeCloseTo(c.probs[i], 5))
    }
  })
  it('falls back to the scalar temperature without a map', () => {
    const p = calibrate([1, 0], 10, { temperature: 1, calibrationMap: null })
    expect(p[0]).toBeCloseTo(1 / (1 + Math.exp(-1)), 6)
  })
})

describe('marginConfidence', () => {
  it('is (n·pmax − 1)/(n − 1), clamped', () => {
    expect(marginConfidence([0.5, 0.5])).toBe(0)
    expect(marginConfidence([1])).toBe(1)
    expect(marginConfidence([0.7, 0.1, 0.1, 0.1])).toBeCloseTo(0.6, 3)
  })
})
