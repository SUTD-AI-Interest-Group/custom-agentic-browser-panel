import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _putArtifactForTests,
  _putArtifactWithoutIndexForTests,
  _resetDbForTests,
  clearMcpArtifacts,
  deleteMcpArtifactsForConversation,
  getMcpArtifact,
  pruneMcpArtifacts,
  saveMcpArtifact,
  type McpArtifact,
} from './mcpArtifacts'

function artifact(overrides: Partial<McpArtifact> & Pick<McpArtifact, 'id' | 'bytes' | 'createdAt'>): McpArtifact {
  return {
    kind: 'image',
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,x',
    title: 'Example',
    server: 's1',
    tool: 't1',
    conversationId: 'c1',
    ...overrides,
  }
}

function rawOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('lychee-mcp')
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

describe('saveMcpArtifact', () => {
  it('returns an id that getMcpArtifact can read back', async () => {
    const id = await saveMcpArtifact({
      kind: 'image',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,x',
      title: 'A screenshot',
      conversationId: 'c1',
      server: 's1',
      tool: 't1',
    })
    const stored = await getMcpArtifact(id)
    expect(stored?.title).toBe('A screenshot')
  })
})

describe('pruneMcpArtifacts', () => {
  it('keeps the newest artifact even when it alone exceeds MAX_TOTAL_BYTES', async () => {
    // MAX_TOTAL_BYTES is 50MB — an MCP tool can plausibly return a single
    // video/audio payload over that. It must survive its own very next prune,
    // not vanish right after saveMcpArtifact handed its id back to the model
    // and the UI rendered a card for it (F4).
    await _putArtifactForTests(artifact({ id: 'huge', bytes: 60 * 1024 * 1024, createdAt: Date.now() }))
    const result = await pruneMcpArtifacts()
    expect(result.deleted).toBe(0)
    expect(await getMcpArtifact('huge')).not.toBeNull()
  })

  it('still evicts an oversized OLDER artifact once a newer one exists', async () => {
    // Both well within MAX_AGE_MS (30 days) — recency here differs only by
    // the byte-cap pass's oldest-first ordering, not by age eviction.
    await _putArtifactForTests(artifact({ id: 'old-huge', bytes: 60 * 1024 * 1024, createdAt: Date.now() - 2_000 }))
    await _putArtifactForTests(artifact({ id: 'new-small', bytes: 10, createdAt: Date.now() - 1_000 }))
    const result = await pruneMcpArtifacts()
    expect(result.deleted).toBe(1)
    expect(await getMcpArtifact('old-huge')).toBeNull()
    expect(await getMcpArtifact('new-small')).not.toBeNull()
  })

  it('evicts artifacts past MAX_AGE_MS regardless of size', async () => {
    const ancient = Date.now() - 31 * 24 * 60 * 60 * 1000 // 31 days old; cap is 30
    await _putArtifactForTests(artifact({ id: 'ancient', bytes: 10, createdAt: ancient }))
    const result = await pruneMcpArtifacts()
    expect(result.deleted).toBe(1)
    expect(await getMcpArtifact('ancient')).toBeNull()
  })
})

// The bug this file fixes: pruneMcpArtifacts used to getAll() the FULL
// `artifacts` store — every dataUrl/text payload — purely to run eviction math
// on three scalar fields, after EVERY saveMcpArtifact. It now reads only a
// lightweight `index` store kept in sync in the same transaction as the full
// record.
describe('pruneMcpArtifacts reads only the lightweight index store', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never calls getAll on the full `artifacts` store — only on `index`', async () => {
    await _putArtifactForTests(artifact({ id: 'a1', bytes: 10 * 1024 * 1024, createdAt: Date.now() - 2_000 }))
    await _putArtifactForTests(artifact({ id: 'a2', bytes: 10, createdAt: Date.now() - 1_000 }))

    const spy = vi.spyOn(IDBObjectStore.prototype, 'getAll')
    await pruneMcpArtifacts()

    const storesRead = spy.mock.instances.map((instance) => (instance as unknown as IDBObjectStore).name)
    expect(storesRead).toContain('index')
    expect(storesRead).not.toContain('artifacts')
  })
})

describe('index stays consistent with the store', () => {
  it('writing an artifact writes matching rows in both `artifacts` and `index`', async () => {
    await _putArtifactForTests(artifact({ id: 'a1', bytes: 555, createdAt: 1000 }))
    const db = await rawOpen()
    try {
      const fullRow = await rawGet<McpArtifact>(db, 'artifacts', 'a1')
      const indexRow = await rawGet<{ id: string; bytes: number; createdAt: number }>(db, 'index', 'a1')
      expect(fullRow).toMatchObject({ id: 'a1', bytes: 555 })
      expect(indexRow).toEqual({ id: 'a1', bytes: 555, createdAt: 1000 })
    } finally {
      db.close()
    }
  })

  it('pruning an artifact removes both its full record and its index row — no phantom left behind', async () => {
    await _putArtifactForTests(artifact({ id: 'old', bytes: 60 * 1024 * 1024, createdAt: Date.now() - 2_000 }))
    await _putArtifactForTests(artifact({ id: 'new', bytes: 10, createdAt: Date.now() - 1_000 }))
    await pruneMcpArtifacts()
    const db = await rawOpen()
    try {
      expect(await rawGet(db, 'artifacts', 'old')).toBeUndefined()
      expect(await rawGet(db, 'index', 'old')).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('deleteMcpArtifactsForConversation removes the index row too — no phantom left behind', async () => {
    await _putArtifactForTests(artifact({ id: 'a1', bytes: 10, createdAt: Date.now(), conversationId: 'target' }))
    await _putArtifactForTests(artifact({ id: 'a2', bytes: 10, createdAt: Date.now(), conversationId: 'other' }))
    await deleteMcpArtifactsForConversation('target')
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

  it('clearMcpArtifacts empties the index store, not just `artifacts`', async () => {
    await _putArtifactForTests(artifact({ id: 'a1', bytes: 10, createdAt: Date.now() }))
    await clearMcpArtifacts()
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
      const req = indexedDB.open('lychee-mcp', 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('artifacts', { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('artifacts', 'readwrite')
        // Recent, not epoch-zero-ish: pruneMcpArtifacts runs an age-eviction
        // pass right after backfilling, so an absolute small timestamp would
        // look 50+ years old and get evicted for the wrong reason.
        tx.objectStore('artifacts').put(artifact({ id: 'legacy-1', bytes: 12_345, createdAt: Date.now() - 1_000 }))
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
    const result = await pruneMcpArtifacts()
    expect(result.deleted).toBe(0)
    expect(await getMcpArtifact('legacy-1')).not.toBeNull()

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

  it('still evicts a backfilled legacy artifact exactly as it would have pre-migration (behavioral equivalence)', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('lychee-mcp', 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('artifacts', { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('artifacts', 'readwrite')
        const ancient = Date.now() - 31 * 24 * 60 * 60 * 1000 // past MAX_AGE_MS (30 days)
        tx.objectStore('artifacts').put(artifact({ id: 'legacy-ancient', bytes: 10, createdAt: ancient }))
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })

    const result = await pruneMcpArtifacts()
    expect(result.deleted).toBe(1)
    expect(await getMcpArtifact('legacy-ancient')).toBeNull()
  })

  it('does not brick the database when one pre-existing artifact fails to project: it is degraded during backfill, not dropped, and the upgrade still completes', async () => {
    // Force the FIRST index write during backfill to throw, simulating a
    // legacy row that defeats toMcpIndexRow's projection. The projection
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
        const req = indexedDB.open('lychee-mcp', 1)
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore('artifacts', { keyPath: 'id' })
          store.createIndex('createdAt', 'createdAt')
        }
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('artifacts', 'readwrite')
          const store = tx.objectStore('artifacts')
          store.put(artifact({ id: 'bad-1', bytes: 111, createdAt: Date.now() - 2_000 }))
          store.put(artifact({ id: 'good-1', bytes: 222, createdAt: Date.now() - 1_000 }))
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      })

      // Must not throw/reject even though the first index write failed.
      await expect(pruneMcpArtifacts()).resolves.toBeDefined()

      const db = await rawOpen()
      try {
        expect(db.version).toBe(2)
        expect(db.objectStoreNames.contains('index')).toBe(true)

        // The degraded row (createdAt: 0) is ancient, so pruneMcpArtifacts'
        // own age pass in this same call evicts it right back out along with
        // its now-orphaned full record — self-healing, not a bug.
        expect(await rawGet(db, 'index', 'bad-1')).toBeUndefined()
        expect(await rawGet(db, 'artifacts', 'bad-1')).toBeUndefined()

        // The healthy row after the failing one is still backfilled AND
        // survives — proof cursor.continue() kept running past the failure.
        const goodRow = await rawGet<{ id: string; bytes: number; createdAt: number }>(db, 'index', 'good-1')
        expect(goodRow?.id).toBe('good-1')
        expect(goodRow?.bytes).toBe(222)
        expect(await getMcpArtifact('good-1')).not.toBeNull()
      } finally {
        db.close()
      }
    } finally {
      IDBObjectStore.prototype.put = originalPut
    }
  })

  it('tolerates an artifact whose index row is missing (drift) without crashing pruneMcpArtifacts', async () => {
    // _putArtifactWithoutIndexForTests writes only the full record —
    // simulating index/store drift from some other cause than a fresh install.
    await _putArtifactWithoutIndexForTests(artifact({ id: 'no-index', bytes: 10, createdAt: Date.now() }))
    await expect(pruneMcpArtifacts()).resolves.toBeDefined()
    // The orphaned full record is simply invisible to pruneMcpArtifacts (it
    // never reads `artifacts` directly) — not evicted, but no throw either.
    expect(await getMcpArtifact('no-index')).not.toBeNull()
  })
})
