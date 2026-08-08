import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _putShotForTests,
  _putShotWithoutIndexForTests,
  _resetDbForTests,
  clearShots,
  deleteShotsForConversation,
  getShot,
  pruneShots,
  type StoredShot,
} from './screenshots'

// pruneShots' eviction math (F4) is exercised directly against the IndexedDB
// store rather than through saveShot(): saveShot's makeThumb() decodes the
// image via a real <canvas>, which jsdom has no native binding for (getContext
// always returns null here — see pdf.test.ts's header comment for the same
// constraint) — _putShotForTests bypasses that entirely and writes only what
// pruneShots actually reads.

function shot(overrides: Partial<StoredShot> & Pick<StoredShot, 'id' | 'bytes' | 'createdAt'>): StoredShot {
  return {
    dataUrl: 'data:image/png;base64,x',
    width: 100,
    height: 100,
    url: 'https://example.com',
    title: 'Example',
    label: 'the full page',
    conversationId: 'c1',
    ...overrides,
  }
}

function rawOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('lychee-screenshots')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function rawGet<T>(db: IDBDatabase, store: string, id: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const get = tx.objectStore(store).get(id)
    get.onsuccess = () => resolve(get.result)
    get.onerror = () => reject(get.error)
  })
}

function rawGetAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

beforeEach(async () => {
  await _resetDbForTests()
})

describe('pruneShots', () => {
  it('keeps the newest shot even when it alone exceeds MAX_TOTAL_BYTES', async () => {
    // MAX_TOTAL_BYTES is 50MB. A single capture over that cap must survive its
    // own very next prune — not vanish out from under the card the UI just
    // rendered for it as "saved" (F4).
    await _putShotForTests(shot({ id: 'huge', bytes: 60 * 1024 * 1024, createdAt: Date.now() }))
    const result = await pruneShots()
    expect(result.deleted).toBe(0)
    expect(await getShot('huge')).not.toBeNull()
  })

  it('still evicts an oversized OLDER shot once a newer one exists', async () => {
    // Both well within MAX_AGE_MS (30 days) — recency here differs only by
    // the byte-cap pass's oldest-first ordering, not by age eviction.
    await _putShotForTests(shot({ id: 'old-huge', bytes: 60 * 1024 * 1024, createdAt: Date.now() - 2_000 }))
    await _putShotForTests(shot({ id: 'new-small', bytes: 10, createdAt: Date.now() - 1_000 }))
    const result = await pruneShots()
    expect(result.deleted).toBe(1)
    expect(await getShot('old-huge')).toBeNull()
    expect(await getShot('new-small')).not.toBeNull()
  })

  it('evicts shots past MAX_AGE_MS regardless of size', async () => {
    const ancient = Date.now() - 31 * 24 * 60 * 60 * 1000 // 31 days old; cap is 30
    await _putShotForTests(shot({ id: 'ancient', bytes: 10, createdAt: ancient }))
    const result = await pruneShots()
    expect(result.deleted).toBe(1)
    expect(await getShot('ancient')).toBeNull()
  })
})

// The bug this file fixes: pruneShots used to getAll() the FULL `shots` store
// — every full-resolution base64 PNG dataUrl — purely to run eviction math on
// three scalar fields, after EVERY saveShot. It now reads only a lightweight
// `index` store kept in sync in the same transaction as the full record.
describe('pruneShots reads only the lightweight index store', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never calls getAll on the full `shots` store — only on `index`', async () => {
    await _putShotForTests(shot({ id: 's1', bytes: 10 * 1024 * 1024, createdAt: Date.now() - 2_000 }))
    await _putShotForTests(shot({ id: 's2', bytes: 10, createdAt: Date.now() - 1_000 }))

    const spy = vi.spyOn(IDBObjectStore.prototype, 'getAll')
    await pruneShots()

    const storesRead = spy.mock.instances.map((instance) => (instance as unknown as IDBObjectStore).name)
    expect(storesRead).toContain('index')
    expect(storesRead).not.toContain('shots')
  })
})

describe('index stays consistent with the store', () => {
  it('writing a shot writes matching rows in both `shots` and `index`', async () => {
    await _putShotForTests(shot({ id: 's1', bytes: 555, createdAt: 1000 }))
    const db = await rawOpen()
    try {
      const shotsRow = await rawGet<StoredShot>(db, 'shots', 's1')
      const indexRow = await rawGet<{ id: string; bytes: number; createdAt: number }>(db, 'index', 's1')
      expect(shotsRow).toMatchObject({ id: 's1', bytes: 555 })
      expect(indexRow).toEqual({ id: 's1', bytes: 555, createdAt: 1000 })
    } finally {
      db.close()
    }
  })

  it('pruning a shot removes both its full record and its index row — no phantom left behind', async () => {
    await _putShotForTests(shot({ id: 'old', bytes: 60 * 1024 * 1024, createdAt: Date.now() - 2_000 }))
    await _putShotForTests(shot({ id: 'new', bytes: 10, createdAt: Date.now() - 1_000 }))
    await pruneShots()
    const db = await rawOpen()
    try {
      expect(await rawGet(db, 'shots', 'old')).toBeUndefined()
      expect(await rawGet(db, 'index', 'old')).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('deleteShotsForConversation removes the index row too — no phantom left behind', async () => {
    await _putShotForTests(shot({ id: 's1', bytes: 10, createdAt: Date.now(), conversationId: 'target' }))
    await _putShotForTests(shot({ id: 's2', bytes: 10, createdAt: Date.now(), conversationId: 'other' }))
    await deleteShotsForConversation('target')
    const db = await rawOpen()
    try {
      expect(await rawGet(db, 'shots', 's1')).toBeUndefined()
      expect(await rawGet(db, 'index', 's1')).toBeUndefined()
      expect(await rawGet(db, 'shots', 's2')).not.toBeUndefined()
      expect(await rawGet(db, 'index', 's2')).not.toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('clearShots empties the index store, not just `shots`/`thumbs`', async () => {
    await _putShotForTests(shot({ id: 's1', bytes: 10, createdAt: Date.now() }))
    await clearShots()
    const db = await rawOpen()
    try {
      expect(await rawGetAll(db, 'index')).toEqual([])
      expect(await rawGetAll(db, 'shots')).toEqual([])
      expect(await rawGetAll(db, 'thumbs')).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('migration: backfilling the index store for a pre-existing (v1) database', () => {
  it('backfills an index row for a shot that already existed before the `index` store did', async () => {
    // Simulate an install that saved shots before the `index` store existed:
    // hand-create a v1 database with the old two-store schema.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('lychee-screenshots', 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('shots', { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
        req.result.createObjectStore('thumbs', { keyPath: 'id' })
      }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('shots', 'readwrite')
        // Recent, not epoch-zero-ish: an absolute small timestamp like 1000ms
        // would look 50+ years old against the real Date.now() the age-based
        // eviction pass compares against, and get evicted for the wrong reason.
        tx.objectStore('shots').put(shot({ id: 'legacy-1', bytes: 12_345, createdAt: Date.now() - 1_000 }))
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })

    // The module's own openDb() should now upgrade 1 -> 2 and backfill, exactly
    // as a side-panel reopen on an existing install would trigger it.
    const result = await pruneShots()
    // The lone legacy shot is well within both caps and must survive.
    expect(result.deleted).toBe(0)
    expect(await getShot('legacy-1')).not.toBeNull()

    const db = await rawOpen()
    try {
      expect(db.objectStoreNames.contains('index')).toBe(true)
      expect(db.version).toBe(2)
      const row = await rawGet<{ id: string; bytes: number; createdAt: number }>(db, 'index', 'legacy-1')
      expect(row?.id).toBe('legacy-1')
      expect(row?.bytes).toBe(12_345)
    } finally {
      db.close()
    }
  })

  it('still evicts a backfilled legacy shot exactly as it would have pre-migration (behavioral equivalence)', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('lychee-screenshots', 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('shots', { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
        req.result.createObjectStore('thumbs', { keyPath: 'id' })
      }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('shots', 'readwrite')
        const ancient = Date.now() - 31 * 24 * 60 * 60 * 1000 // past MAX_AGE_MS (30 days)
        tx.objectStore('shots').put(shot({ id: 'legacy-ancient', bytes: 10, createdAt: ancient }))
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })

    const result = await pruneShots()
    expect(result.deleted).toBe(1)
    expect(await getShot('legacy-ancient')).toBeNull()
  })

  it('does not brick the database when one pre-existing shot fails to project: it is degraded, not dropped, and the upgrade still completes', async () => {
    // Force the FIRST index write during backfill to throw, simulating a
    // legacy row that defeats toShotIndexRow's projection. The projection
    // itself is a flat field copy with nothing to recurse over, so — unlike
    // conversations.ts's summaries backfill — there is no realistic value a
    // legitimately-stored shot could hold that makes it throw; this monkeypatch
    // exercises the SAME defensive try/catch structure conversations.ts uses,
    // proving one bad row can't abort the whole upgrade even if some future
    // change to the projection makes a throw reachable again.
    const originalPut = IDBObjectStore.prototype.put
    let putCount = 0
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<typeof originalPut>) {
      if (this.name === 'index') {
        putCount++
        if (putCount === 1) throw new Error('simulated malformed row')
      }
      return originalPut.apply(this, args)
    } as typeof originalPut

    try {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('lychee-screenshots', 1)
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore('shots', { keyPath: 'id' })
          store.createIndex('createdAt', 'createdAt')
          req.result.createObjectStore('thumbs', { keyPath: 'id' })
        }
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('shots', 'readwrite')
          const store = tx.objectStore('shots')
          // Recent, not epoch-zero-ish: pruneShots() below runs its OWN
          // age-eviction pass right after the backfill in the same call, so an
          // absolute small timestamp would look 50+ years old and get evicted
          // for the wrong reason before the assertions below ever run.
          store.put(shot({ id: 'bad-1', bytes: 111, createdAt: Date.now() - 2_000 }))
          store.put(shot({ id: 'good-1', bytes: 222, createdAt: Date.now() - 1_000 }))
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      })

      // Must not throw/reject even though the first index write failed.
      await expect(pruneShots()).resolves.toBeDefined()

      const db = await rawOpen()
      try {
        expect(db.version).toBe(2)
        expect(db.objectStoreNames.contains('index')).toBe(true)

        // The failed row is degraded (createdAt: 0, bytes: 0) rather than
        // silently dropped from the index entirely — and being ancient
        // (createdAt: 0), pruneShots' own age pass in this same call evicts it
        // right back out, along with its now-orphaned full record. That's the
        // intended self-healing behavior, not a bug: verify the eviction
        // reached both stores rather than leaving a phantom in either.
        expect(await rawGet(db, 'index', 'bad-1')).toBeUndefined()
        expect(await rawGet(db, 'shots', 'bad-1')).toBeUndefined()

        // The healthy row after the failing one is still backfilled AND
        // survives (well within both caps) — proof cursor.continue() kept
        // running past the failure and the rest of the upgrade completed.
        const goodRow = await rawGet<{ id: string; bytes: number; createdAt: number }>(db, 'index', 'good-1')
        expect(goodRow?.id).toBe('good-1')
        expect(goodRow?.bytes).toBe(222)
        expect(await getShot('good-1')).not.toBeNull()
      } finally {
        db.close()
      }
    } finally {
      IDBObjectStore.prototype.put = originalPut
    }
  })

  it('tolerates a shot whose index row is missing (drift) without crashing pruneShots', async () => {
    // _putShotWithoutIndexForTests writes only the full record — simulating
    // index/store drift from some other cause than a fresh install.
    await _putShotWithoutIndexForTests(shot({ id: 'no-index', bytes: 10, createdAt: Date.now() }))
    await expect(pruneShots()).resolves.toBeDefined()
    // The orphaned full record is simply invisible to pruneShots (it never
    // reads `shots` directly) — it is not evicted, but the call does not throw.
    expect(await getShot('no-index')).not.toBeNull()
  })
})
