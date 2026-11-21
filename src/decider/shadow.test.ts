import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { SHADOW_CAP, clearShadow, listShadow, putShadow, type ShadowRecord } from './shadowStore'
import { summarize } from './stats'

function rec(over: Partial<ShadowRecord> = {}): ShadowRecord {
  return {
    id: 'r', conversationId: 'c', seq: 0, at: 0, kind: 'next', modelId: 'm', tokens: 10, ms: 100,
    backend: 'wasm', cold: false, llm: null, top3: [{ op: 'click', p: 0.9 }], agree: true, wouldAct: true,
    ...over,
  }
}

describe('shadow store', () => {
  beforeEach(async () => {
    await clearShadow()
  })

  it('round-trips put then list', async () => {
    const r = rec({ id: 'a', at: 5, fill: [{ index: 1, key: 'email', p: 0.8, llmAgrees: null }] })
    await putShadow(r)
    expect(await listShadow()).toEqual([r])
  })

  it('prunes to the newest SHADOW_CAP', async () => {
    for (let i = 0; i < SHADOW_CAP + 5; i++) await putShadow(rec({ id: `r${i}`, at: i }))
    const all = await listShadow()
    expect(all.length).toBe(SHADOW_CAP)
    const ids = new Set(all.map((r) => r.id))
    expect(ids.has('r0')).toBe(false)
    expect(ids.has('r4')).toBe(false)
    expect(ids.has('r5')).toBe(true)
    expect(ids.has(`r${SHADOW_CAP + 4}`)).toBe(true)
  }, 120000)
})

describe('summarize', () => {
  const records = [
    rec({ id: '1', ms: 100, top3: [{ op: 'a', p: 0.95 }], agree: true }),
    rec({ id: '2', ms: 200, top3: [{ op: 'a', p: 0.55 }], agree: false }),
    rec({ id: '3', kind: 'fill', ms: 5000, cold: true, top3: [{ op: 'a', p: 0.12 }], agree: null }),
    rec({ id: '4', kind: 'fill', ms: 300, top3: [{ op: 'a', p: 1.0 }], agree: true }),
    rec({ id: '5', skipped: 'error', ms: 1, top3: [], agree: null }),
  ]
  const s = summarize(records, 0.9)

  it('counts and agreement', () => {
    expect(s.n).toBe(4)
    expect(s.skipped).toBe(1)
    expect(s.agreement).toBeCloseTo(2 / 3)
    expect(s.byKind.next).toEqual({ n: 2, agreement: 0.5 })
    expect(s.byKind.fill.n).toBe(2)
    expect(s.byKind.fill.agreement).toBe(1)
  })

  it('calibration buckets', () => {
    expect(s.calibration).toHaveLength(10)
    expect(s.calibration[1]).toMatchObject({ lo: 0.1, n: 1, agreement: 0 })
    expect(s.calibration[5].n).toBe(1)
    expect(s.calibration[5].agreement).toBe(0)
    expect(s.calibration[9].n).toBe(2)
    expect(s.calibration[9].agreement).toBe(1)
  })

  it('coverage and latency exclude cold', () => {
    expect(s.coverage).toBe(2 / 4)
    expect(s.p50).toBe(200)
    expect(s.p95).toBe(300)
    expect(s.coldP50).toBe(5000)
  })

  it('empty input is safe', () => {
    const e = summarize([], 0.9)
    expect(e.n).toBe(0)
    expect(e.coldP50).toBeNull()
    expect(e.agreement).toBe(0)
  })
})
