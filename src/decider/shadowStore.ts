// Local shadow log of the on-device decider's decisions, compared against what
// the LLM actually did. Own database, same one-DB-per-store shape as
// src/data/traces.ts.
//
// NO USER DATA BY CONSTRUCTION (the traces.ts rule): a ShadowRecord holds
// numbers, enums, op names and indices. `fill[].key` is a lookup key NAME
// ("email"), never the value typed. Do not add a free-form string field.

export interface ShadowRecord {
  id: string
  conversationId: string
  seq: number
  at: number
  kind: 'next' | 'fill'
  modelId: string
  tokens: number
  ms: number
  backend: 'webgpu' | 'wasm'
  cold: boolean
  llm: { op: string; index?: number } | null
  top3: { op: string; index?: number; p: number }[]
  agree: boolean | null
  wouldAct: boolean
  /** `key` is the lookup key NAME only, never a value. */
  fill?: { index: number; key: string; p: number; llmAgrees: boolean | null }[]
  skipped?: 'too-long' | 'error'
}

export const SHADOW_CAP = 5000

const DB_NAME = 'lychee-decider'
// 2, not 1, and the upgrade below is idempotent: a version-less `indexedDB.open(DB_NAME)` made
// anywhere before the first record (a harness reader, a devtools snippet) CREATES an empty v1
// database, and at v1 this store's own open would never upgrade into it again — every put/list
// would then fail for the life of the profile. Opening at 2 heals that (and a store missing its
// index) while keeping any records a healthy v1 already holds.
const DB_VERSION = 2
const STORE = 'shadow'
const AT_INDEX = 'at'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        const s = db.objectStoreNames.contains(STORE)
          ? req.transaction!.objectStore(STORE)
          : db.createObjectStore(STORE, { keyPath: 'id' })
        if (!s.indexNames.contains(AT_INDEX)) s.createIndex(AT_INDEX, 'at')
      }
      req.onsuccess = () => {
        req.result.onversionchange = () => {
          req.result.close()
          dbPromise = null
        }
        resolve(req.result)
      }
      req.onerror = () => {
        dbPromise = null
        reject(req.error)
      }
    })
  }
  return dbPromise
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/** Store one record, then drop the oldest (by `at`) beyond SHADOW_CAP. */
export async function putShadow(r: ShadowRecord): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  store.put(r)
  const countReq = store.count()
  countReq.onsuccess = () => {
    let excess = countReq.result - SHADOW_CAP
    if (excess <= 0) return
    // Walk the `at` index oldest-first, deleting only the excess.
    const cur = store.index(AT_INDEX).openKeyCursor()
    cur.onsuccess = () => {
      const c = cur.result
      if (!c || excess <= 0) return
      store.delete(c.primaryKey)
      excess--
      c.continue()
    }
  }
  await done(tx)
}

/** All records, oldest first. */
export async function listShadow(): Promise<ShadowRecord[]> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readonly')
  const req = tx.objectStore(STORE).index(AT_INDEX).getAll()
  await done(tx)
  return req.result as ShadowRecord[]
}

export async function clearShadow(): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).clear()
  await done(tx)
}
