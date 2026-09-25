import { describe, it, expect } from 'vitest'
import golden from './__fixtures__/von-golden.json'
import { calibrate, marginConfidence, packPrompt, planSequence, VonInputError } from './von'

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
