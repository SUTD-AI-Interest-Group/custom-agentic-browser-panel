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
const DB_VERSION = 1
const STORE = 'shadow'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id' })
          s.createIndex('at', 'at')
        }
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
    const cur = store.index('at').openKeyCursor()
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
  const req = tx.objectStore(STORE).index('at').getAll()
  await done(tx)
  return req.result as ShadowRecord[]
}

export async function clearShadow(): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).clear()
  await done(tx)
}
