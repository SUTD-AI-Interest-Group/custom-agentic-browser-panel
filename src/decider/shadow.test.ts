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

  it('counts drive decisions apart, and never as agreement (there is no chat-model action to compare)', () => {
    const d = summarize([...records, rec({ id: '6', kind: 'drive', agree: null, top3: [{ op: 'click', index: 3, p: 0.92 }] })], 0.9)
    expect(d.byKind.drive).toEqual({ n: 1, agreement: 0 })
    expect(d.byKind.next).toEqual(s.byKind.next)
    expect(d.agreement).toBeCloseTo(2 / 3) // unchanged: a drive record is unjudged
    expect(d.n).toBe(5)
    expect(s.byKind.drive).toEqual({ n: 0, agreement: 0 })
  })

  it('empty input is safe', () => {
    const e = summarize([], 0.9)
    expect(e.n).toBe(0)
    expect(e.coldP50).toBeNull()
    expect(e.agreement).toBe(0)
  })
})

// A version-less `indexedDB.open('lychee-decider')` (a harness reader, a devtools snippet) on a
// profile that has never written a record CREATES an empty v1 database. Under DB_VERSION 1 the
// store's own open then never upgraded, and every put/list failed for the life of the profile.
describe('shadow store heals a database it did not create', () => {
  const raw = (version?: number, onUpgrade?: (db: IDBDatabase) => void) =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = version === undefined ? indexedDB.open('lychee-decider') : indexedDB.open('lychee-decider', version)
      req.onupgradeneeded = () => onUpgrade?.(req.result)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  const drop = () =>
    new Promise<void>((resolve, reject) => {
      // The store's own connection closes itself on versionchange, so this never blocks.
      const req = indexedDB.deleteDatabase('lychee-decider')
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  const putRaw = (db: IDBDatabase, r: ShadowRecord) =>
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction('shadow', 'readwrite')
      tx.objectStore('shadow').put(r)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })

  it('an empty v1 database (no shadow store) is healed on the first put', async () => {
    await drop()
    const empty = await raw() // version-less: creates v1 with no stores
    expect(empty.version).toBe(1)
    expect(empty.objectStoreNames.contains('shadow')).toBe(false)
    empty.close()

    const r = rec({ id: 'healed', at: 1 })
    await putShadow(r)
    expect(await listShadow()).toEqual([r])
  })

  it('an empty v1 database is healed on the first list, too', async () => {
    await drop()
    ;(await raw()).close()
    expect(await listShadow()).toEqual([])
    await putShadow(rec({ id: 'after', at: 2 }))
    expect((await listShadow()).map((x) => x.id)).toEqual(['after'])
  })

  it('a v1 store missing its `at` index gets one, and its records survive', async () => {
    await drop()
    const v1 = await raw(1, (db) => {
      db.createObjectStore('shadow', { keyPath: 'id' }) // no index
    })
    await putRaw(v1, rec({ id: 'old', at: 5 }))
    v1.close()

    await putShadow(rec({ id: 'new', at: 9 }))
    expect((await listShadow()).map((x) => x.id)).toEqual(['old', 'new'])
  })

  it('a healthy v1 database keeps its records across the upgrade', async () => {
    await drop()
    const v1 = await raw(1, (db) => {
      db.createObjectStore('shadow', { keyPath: 'id' }).createIndex('at', 'at')
    })
    await putRaw(v1, rec({ id: 'kept', at: 3 }))
    v1.close()

    expect((await listShadow()).map((x) => x.id)).toEqual(['kept'])
    const now = await raw()
    expect(now.version).toBe(2)
    now.close()
  })
})
