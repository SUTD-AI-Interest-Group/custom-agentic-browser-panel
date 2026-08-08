import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _putArtifactForTests,
  _putArtifactWithoutIndexForTests,
  _resetDbForTests,
  clearArtifacts,
  deleteArtifactsForConversation,
  getArtifact,
  planPrune,
  prune,
  saveArtifact,
  updateArtifactContent,
  type CodeArtifact,
} from './artifacts'

function row(id: string, bytes: number, updatedAt: number) {
  return { id, bytes, updatedAt }
}

describe('planPrune', () => {
  it('evicts nothing under the cap', () => {
    expect(planPrune([row('a', 100, 1), row('b', 100, 2)], 1000)).toEqual([])
  })

  it('evicts oldest-updated first until under the cap', () => {
    const rows = [row('new', 400, 30), row('old', 400, 10), row('mid', 400, 20)]
    expect(planPrune(rows, 900)).toEqual(['old'])
    expect(planPrune(rows, 500)).toEqual(['old', 'mid'])
  })

  it('keeps a single over-cap newest row only when nothing else can go', () => {
    // One huge artifact alone: evicting it would leave nothing — it stays.
    expect(planPrune([row('only', 5000, 1)], 1000)).toEqual([])
    // But with a newer sibling, the older huge one goes.
    expect(planPrune([row('huge-old', 5000, 1), row('small-new', 10, 2)], 1000)).toEqual(['huge-old'])
  })
})

function artifact(overrides: Partial<CodeArtifact> & Pick<CodeArtifact, 'id' | 'bytes' | 'updatedAt'>): CodeArtifact {
  const now = overrides.createdAt ?? overrides.updatedAt
  return {
    title: 'Example',
    html: '<html></html>',
    revision: 1,
    createdAt: now,
    conversationId: 'c1',
    ...overrides,
  }
}

function rawOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('lychee-artifacts')
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

// This store's internal prune() (byte-cap only, no age eviction — unlike
// screenshots.ts/mcpArtifacts.ts) used to getAll() the FULL `artifacts` store
// — every artifact's complete HTML document — purely to run eviction math on
// two scalar fields, after EVERY saveArtifact AND updateArtifactContent.
// UpdateArtifact is the worst case: iterative refinement can fire it many
// times in one turn.
describe('prune (via saveArtifact/updateArtifactContent)', () => {
  it('keeps the newest artifact even when it alone exceeds MAX_TOTAL_BYTES', async () => {
    // MAX_TOTAL_BYTES is 20MB.
    await _putArtifactForTests(artifact({ id: 'huge', bytes: 25 * 1024 * 1024, updatedAt: Date.now() }))
    await prune()
    expect(await getArtifact('huge')).not.toBeNull()
  })

  it('still evicts an oversized OLDER artifact once a newer one exists', async () => {
    await _putArtifactForTests(artifact({ id: 'old-huge', bytes: 25 * 1024 * 1024, updatedAt: Date.now() - 2_000 }))
    await _putArtifactForTests(artifact({ id: 'new-small', bytes: 10, updatedAt: Date.now() - 1_000 }))
    await prune()
    expect(await getArtifact('old-huge')).toBeNull()
    expect(await getArtifact('new-small')).not.toBeNull()
  })

  it('saveArtifact and updateArtifactContent each kick off their own (fire-and-forget) prune pass', async () => {
    // saveArtifact/updateArtifactContent deliberately do NOT await their own
    // prune() call ("a full disk must not fail the tool call the model
    // awaits") — so this exercises the real call sites, not the direct
    // export, and tolerates the eviction landing a tick later.
    await _putArtifactForTests(artifact({ id: 'old-huge', bytes: 25 * 1024 * 1024, updatedAt: Date.now() - 2_000 }))
    const created = await saveArtifact({ title: 'doc', html: '<p>v1</p>', conversationId: 'c1' })
    await updateArtifactContent(created.id, { html: '<p>v2, longer content here</p>' })
    // Flush the microtask queue so both fire-and-forget prune() calls settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await getArtifact('old-huge')).toBeNull()
  })

  it('updateArtifactContent bumps revision/bytes', async () => {
    const created = await saveArtifact({ title: 'doc', html: '<p>v1</p>', conversationId: 'c1' })
    const updated = await updateArtifactContent(created.id, { html: '<p>v2, longer content here</p>' })
    expect(updated?.revision).toBe(2)
    expect(updated?.html).toBe('<p>v2, longer content here</p>')
  })
})

describe('prune reads only the lightweight index store', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never calls getAll on the full `artifacts` store — only on `index`', async () => {
    await _putArtifactForTests(artifact({ id: 'a1', bytes: 5 * 1024 * 1024, updatedAt: Date.now() - 2_000 }))
    await _putArtifactForTests(artifact({ id: 'a2', bytes: 10, updatedAt: Date.now() - 1_000 }))

    const spy = vi.spyOn(IDBObjectStore.prototype, 'getAll')
    await prune()

    const storesRead = spy.mock.instances.map((instance) => (instance as unknown as IDBObjectStore).name)
    expect(storesRead).toContain('index')
    expect(storesRead).not.toContain('artifacts')
  })
})

describe('index stays consistent with the store', () => {
  it('saveArtifact writes matching rows in both `artifacts` and `index`', async () => {
    const created = await saveArtifact({ title: 'doc', html: '<p>hello</p>', conversationId: 'c1' })
    const db = await rawOpen()
    try {
      const fullRow = await rawGet<CodeArtifact>(db, 'artifacts', created.id)
      const indexRow = await rawGet<{ id: string; bytes: number; updatedAt: number }>(db, 'index', created.id)
      expect(fullRow?.html).toBe('<p>hello</p>')
      expect(indexRow).toEqual({ id: created.id, bytes: created.bytes, updatedAt: created.updatedAt })
    } finally {
      db.close()
    }
  })

  it('updateArtifactContent keeps the index row in sync with the new bytes/updatedAt', async () => {
    const created = await saveArtifact({ title: 'doc', html: '<p>v1</p>', conversationId: 'c1' })
    const updated = await updateArtifactContent(created.id, { html: '<p>v2 is longer</p>' })
    const db = await rawOpen()
    try {
      const indexRow = await rawGet<{ id: string; bytes: number; updatedAt: number }>(db, 'index', created.id)
      expect(indexRow?.bytes).toBe(updated?.bytes)
      expect(indexRow?.updatedAt).toBe(updated?.updatedAt)
      // The index row was updated, not left stale at the create-time value.
      expect(indexRow?.bytes).not.toBe(created.bytes)
    } finally {
      db.close()
    }
  })

  it('pruning an artifact removes both its full record and its index row — no phantom left behind', async () => {
    await _putArtifactForTests(artifact({ id: 'old-huge', bytes: 25 * 1024 * 1024, updatedAt: Date.now() - 2_000 }))
    await _putArtifactForTests(artifact({ id: 'new-small', bytes: 10, updatedAt: Date.now() - 1_000 }))
    await prune()
    const db = await rawOpen()
    try {
      expect(await rawGet(db, 'artifacts', 'old-huge')).toBeUndefined()
      expect(await rawGet(db, 'index', 'old-huge')).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('deleteArtifactsForConversation removes the index row too — no phantom left behind', async () => {
    await _putArtifactForTests(artifact({ id: 'a1', bytes: 10, updatedAt: Date.now(), conversationId: 'target' }))
    await _putArtifactForTests(artifact({ id: 'a2', bytes: 10, updatedAt: Date.now(), conversationId: 'other' }))
    await deleteArtifactsForConversation('target')
    const db = await rawOpen()
    try {
      expect(await rawGet(db, 'artifacts', 'a1')).toBeUndefined()
      expect(await rawGet(db, 'index', 'a1')).toBeUndefined()
      expect(await rawGet(db, 'artifacts', 'a2')).not.toBeUndefined()
      expect(await rawGet(db, 'index', 'a2')).not.toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('clearArtifacts empties the index store, not just `artifacts`', async () => {
    await _putArtifactForTests(artifact({ id: 'a1', bytes: 10, updatedAt: Date.now() }))
    await clearArtifacts()
    const db = await rawOpen()
    try {
      expect(await rawGetAll(db, 'index')).toEqual([])
      expect(await rawGetAll(db, 'artifacts')).toEqual([])
    } finally {
      db.close()
    }
  })
})

describe('migration: backfilling the index store for a pre-existing (v1) database', () => {
  it('backfills an index row for an artifact that already existed before the `index` store did', async () => {
    // Simulate an install that saved artifacts before the `index` store
    // existed: hand-create a v1 database with the old single-store schema.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('lychee-artifacts', 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('artifacts', { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('artifacts', 'readwrite')
        tx.objectStore('artifacts').put(artifact({ id: 'legacy-1', bytes: 12_345, updatedAt: 1000 }))
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
    expect(await getArtifact('legacy-1')).not.toBeNull()

    const db = await rawOpen()
    try {
      expect(db.objectStoreNames.contains('index')).toBe(true)
      expect(db.version).toBe(2)
      const indexRow = await rawGet<{ id: string; bytes: number; updatedAt: number }>(db, 'index', 'legacy-1')
      expect(indexRow).toEqual({ id: 'legacy-1', bytes: 12_345, updatedAt: 1000 })
    } finally {
      db.close()
    }
  })

  it('still evicts a backfilled legacy artifact exactly as it would have pre-migration (behavioral equivalence)', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('lychee-artifacts', 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('artifacts', { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('artifacts', 'readwrite')
        tx.objectStore('artifacts').put(artifact({ id: 'legacy-old', bytes: 25 * 1024 * 1024, updatedAt: 1000 }))
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })

    // Trigger the module's own openDb() (v1 -> v2 + backfill): the lone legacy
    // artifact busts the 20MB cap but is the ONLY row, so an explicit prune()
    // right now must not evict it — proof the backfilled index row carries
    // real bytes/updatedAt, not zeroed-out placeholders.
    expect(await getArtifact('legacy-old')).not.toBeNull()
    await prune()
    expect(await getArtifact('legacy-old')).not.toBeNull()

    // Once a newer sibling exists, the byte cap evicts the older one — same
    // eviction math a pre-migration store would have applied.
    await _putArtifactForTests(artifact({ id: 'sibling', bytes: 10, updatedAt: Date.now() }))
    await prune()
    expect(await getArtifact('legacy-old')).toBeNull()
  })

  it('does not brick the database when one pre-existing artifact fails to project: it is degraded during backfill, not dropped, and the upgrade still completes', async () => {
    // Force the FIRST index write during backfill to throw, simulating a
    // legacy row that defeats toArtifactIndexRow's projection. The projection
    // itself is a flat field copy with nothing to recurse over, so — unlike
    // conversations.ts's summaries backfill — there is no realistic value a
    // legitimately-stored artifact could hold that makes it throw; this
    // monkeypatch exercises the SAME defensive try/catch structure
    // conversations.ts uses, proving one bad row can't abort the whole
    // upgrade even if a future change to the projection makes a throw
    // reachable again.
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
        const req = indexedDB.open('lychee-artifacts', 1)
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore('artifacts', { keyPath: 'id' })
          store.createIndex('createdAt', 'createdAt')
        }
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('artifacts', 'readwrite')
          const store = tx.objectStore('artifacts')
          store.put(artifact({ id: 'bad-1', bytes: 111, updatedAt: 100 }))
          store.put(artifact({ id: 'good-1', bytes: 222, updatedAt: 200 }))
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      })

      // Must not throw/reject even though the first index write failed.
      // getArtifact triggers openDb(), which triggers the v1->v2 upgrade.
      await expect(getArtifact('good-1')).resolves.not.toBeNull()

      const db = await rawOpen()
      try {
        expect(db.version).toBe(2)
        expect(db.objectStoreNames.contains('index')).toBe(true)

        // Unlike screenshots.ts/mcpArtifacts.ts, this store has NO age-based
        // eviction — a degraded row (updatedAt: 0) is simply oldest-first in
        // line for the byte cap, not unconditionally evicted. Well within the
        // 20MB cap here, so the degraded row survives the backfill visibly.
        const badRow = await rawGet<{ id: string; bytes: number; updatedAt: number }>(db, 'index', 'bad-1')
        expect(badRow).toEqual({ id: 'bad-1', bytes: 0, updatedAt: 0 })

        // The row AFTER the failing one is still backfilled correctly — proof
        // cursor.continue() kept running past the failure.
        const goodRow = await rawGet<{ id: string; bytes: number; updatedAt: number }>(db, 'index', 'good-1')
        expect(goodRow).toEqual({ id: 'good-1', bytes: 222, updatedAt: 200 })

        // The original full record is untouched by the failed projection.
        const rawArtifact = await rawGet<CodeArtifact>(db, 'artifacts', 'bad-1')
        expect(rawArtifact?.bytes).toBe(111)
      } finally {
        db.close()
      }
    } finally {
      IDBObjectStore.prototype.put = originalPut
    }
  })

  it('tolerates an artifact whose index row is missing (drift) without crashing prune', async () => {
    // _putArtifactWithoutIndexForTests writes only the full record —
    // simulating index/store drift from some other cause than a fresh install.
    await _putArtifactWithoutIndexForTests(artifact({ id: 'no-index', bytes: 10, updatedAt: Date.now() }))
    await expect(prune()).resolves.toBeUndefined()
    // The orphaned full record is simply invisible to prune() (it never reads
    // `artifacts` directly) — not evicted, but no throw either.
    expect(await getArtifact('no-index')).not.toBeNull()
  })
})
