import { describe, expect, it } from 'vitest'
import { parseManifest } from './manifest'
import { packPass } from './pack'
import { codeProbabilities, toAnswer } from './readout'
import { normalizeDecider } from './config'
import type { RenderedQuestion } from './prompt'

const manifest = (): Record<string, any> => ({
  format: 1, modelId: 'm', revision: 'r', hidden: 1536, layers: 35, pleDim: 256, vocab: 262144,
  temperature: 1.5456, softcap: 30, maxLength: 4096,
  controlTokenIds: { bos: 2 }, codeTokenIds: [1, 2, 3],
  tables: { blockSize: 1024, embed: { file: 'embed.bin', blocks: 4 }, ple: { file: 'ple.bin', blocks: 8 } },
  chunkBytes: 1048576,
  files: [{ name: 'embed.bin', bytes: 10, sha256: ['ab'] }],
})

describe('packPass', () => {
  it('packs state then questions', () => {
    expect(packPass([1, 2, 3], [[7, 8], [9]])).toEqual({
      ids: [1, 2, 3, 7, 8, 9], positions: [0, 1, 2, 3, 4, 3], segments: [0, 0, 0, 1, 1, 2], gather: [4, 5],
    })
  })
})

describe('codeProbabilities', () => {
  it('uniform for zero logits', () => {
    const p = codeProbabilities(new Array(255).fill(0), 0, 3, 30, 1.5456)
    p.forEach((x) => expect(x).toBeCloseTo(1 / 3, 9))
  })
  it('applies softcap and temperature, row-indexed', () => {
    const l = new Array(510).fill(0)
    l[255] = 30
    const p = codeProbabilities(l, 1, 2, 30, 1.5456)
    expect(p[0]).toBeCloseTo(1 / (1 + Math.exp(-(30 * Math.tanh(1)) / 1.5456)), 6)
    expect(p[0] + p[1]).toBeCloseTo(1, 9)
  })
})

describe('toAnswer', () => {
  const q = (kind: RenderedQuestion['kind'], options: string[]): RenderedQuestion => ({ name: 'q', kind, ids: [], options })
  it('choice confidence', () => {
    const a = toAnswer(q('choice', ['a', 'b', 'c']), [0.7, 0.2, 0.1])
    expect(a.top).toBe('a')
    expect(a.p).toBeCloseTo(0.7)
    expect(a.confidence).toBeCloseTo((3 * 0.7 - 1) / 2)
    expect(a.yes).toBeUndefined()
  })
  it('noul yes', () => {
    const a = toAnswer(q('noul', ['false', 'true']), [0.25, 0.75])
    expect(a.yes).toBeCloseTo(0.75)
    expect(a.top).toBe('true')
  })
  it('score std-dev confidence', () => {
    expect(toAnswer(q('score', ['0', '1', '2']), [0, 1, 0]).confidence).toBeCloseTo(1)
    expect(toAnswer(q('score', ['0', '1', '2']), [0.5, 0, 0.5]).confidence).toBeCloseTo(0)
  })
})

describe('parseManifest', () => {
  it('accepts the shape', () => expect(parseManifest(manifest()).softcap).toBe(30))
  it('names a missing field', () => {
    const m = manifest()
    delete m.softcap
    expect(() => parseManifest(m)).toThrow(/softcap/)
  })
  it('rejects non-objects and bad nested', () => {
    expect(() => parseManifest('x')).toThrow(/manifest/)
    const m = manifest()
    m.tables.embed = {}
    expect(() => parseManifest(m)).toThrow(/tables/)
  })
})

describe('normalizeDecider', () => {
  it('normalizes', () => {
    expect(normalizeDecider(undefined)).toBeUndefined()
    expect(normalizeDecider({ mode: 'shadow' })).toEqual({ mode: 'shadow' })
    expect(normalizeDecider({ mode: 'driver' })).toBeUndefined()
    expect(normalizeDecider({ mode: 'assist', actThreshold: 2 })).toEqual({ mode: 'assist' })
    expect(normalizeDecider({ mode: 'assist', actThreshold: 0.7, extra: 1 })).toEqual({ mode: 'assist', actThreshold: 0.7 })
    expect(normalizeDecider('x')).toBeUndefined()
  })
})
