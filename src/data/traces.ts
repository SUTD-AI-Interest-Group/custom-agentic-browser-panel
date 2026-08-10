// Local, redacted traces of what a turn actually did — the step timeline, the
// tools disclosed at each step, repairs, and token usage.
//
// The most interesting machinery in this app is invisible at runtime: which
// tools progressive disclosure exposed and why, `repairToolCall` rewriting an
// unloaded-tool call into GetTool, imageQueue drains, budget consumed. The only
// existing window is Langfuse — an optional beta that ships content off-device,
// so most installs have none. `RunCode` shipped broken and the whole suite
// passed throughout, because nothing local showed what happened in the browser.
//
// Its own database, same one-DB-per-store shape as conversations.ts /
// screenshots.ts, so no module has to coordinate schema versions with another.
// A lightweight `index` store mirrors {id, bytes, createdAt} and is written in
// the SAME transaction as the record, so pruning never deserializes a full
// trace just to run the eviction math — the screenshots.ts lesson.
//
// EVERYTHING WRITTEN HERE HAS ALREADY PASSED THROUGH `redactSecrets`. A step's
// tool inputs routinely carry real secrets typed through a page (ControlPage's
// `text`/`value`, AutofillForm's `fields[].value`), so the capture side
// (src/agent/agent.ts) redacts before it ever reaches this module. This store
// does no redaction of its own — it must never be handed raw input.

import { estimateBytes, planPrune, type StoreUsage } from './usage'
import type { ModelUsage } from '../agent/observability'

/** One model step: what was available, what it called, what it cost. */
export interface TraceStep {
  /** 0-based step index within the turn. */
  index: number
  startedAt: number
  durationMs: number
  /** Model id as the provider reported it, when it differs from the request. */
  model?: string
  /** Tool names exposed to the model this step (progressive disclosure). */
  activeTools: string[]
  toolCalls: Array<{ name: string; ok: boolean }>
  usage?: ModelUsage
  finishReason?: string
  /** Set when `repairToolCall` rewrote a call — usually an unloaded tool into GetTool. */
  repaired?: { from: string; to: string }
  /** Images drained from the queue into a synthetic user message before this step. */
  imagesDrained?: number
}

/** One turn's trace. `id` is the turn id the UI looks it up by. */
export interface StoredTrace {
  id: string
  conversationId: string
  createdAt: number
  /** First line of the user message that opened the turn, for the drawer header. */
  label: string
  steps: TraceStep[]
  bytes: number
}

/** Lightweight mirror row, so pruning never reads a full trace. */
interface TraceIndexRow {
  id: string
  conversationId: string
  bytes: number
  createdAt: number
}

const DB_NAME = 'lychee-traces'
const DB_VERSION = 1
const STORE = 'traces'
const INDEX_STORE = 'index'

// Traces are small (no image data, no page text — just names, counts and
// timings), so a modest cap holds a great many turns.
const MAX_TOTAL_BYTES = 5 * 1024 * 1024
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(INDEX_STORE)) {
          db.createObjectStore(INDEX_STORE, { keyPath: 'id' })
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

function requestOn<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(store, mode).objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

/**
 * Store one turn's trace and its index row in a single transaction, then prune.
 *
 * Both halves must land together for the same reason `summaries` must: an index
 * row that outlived its record would have pruning chasing a ghost, and a record
 * with no index row would be invisible to pruning and never evicted.
 */
export async function saveTrace(
  input: Omit<StoredTrace, 'bytes'>,
): Promise<void> {
  const record: StoredTrace = { ...input, bytes: estimateBytes(input) }
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, INDEX_STORE], 'readwrite')
    tx.objectStore(STORE).put(record)
    tx.objectStore(INDEX_STORE).put({
      id: record.id,
      conversationId: record.conversationId,
      bytes: record.bytes,
      createdAt: record.createdAt,
    })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  await pruneTraces().catch(() => {})
}

/** One turn's trace, or undefined if it was never recorded or has been pruned. */
export async function getTrace(id: string): Promise<StoredTrace | undefined> {
  return requestOn<StoredTrace | undefined>(STORE, 'readonly', (s) => s.get(id))
}

/** Delete one trace and its index row together. */
async function remove(id: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, INDEX_STORE], 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.objectStore(INDEX_STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/** Age + byte-cap eviction, reading ONLY the lightweight index store. */
export async function pruneTraces(): Promise<{ deleted: number }> {
  const all = await requestOn<TraceIndexRow[]>(INDEX_STORE, 'readonly', (s) => s.getAll())
  const doomed = planPrune(
    all.map((t) => ({ id: t.id, bytes: t.bytes, recency: t.createdAt })),
    { maxTotalBytes: MAX_TOTAL_BYTES, maxAgeMs: MAX_AGE_MS },
  )
  await Promise.all(doomed.map(remove))
  return { deleted: doomed.length }
}

/** Cascade: a deleted conversation takes its traces with it. */
export async function deleteTracesForConversation(conversationId: string): Promise<void> {
  const all = await requestOn<TraceIndexRow[]>(INDEX_STORE, 'readonly', (s) => s.getAll())
  await Promise.all(all.filter((t) => t.conversationId === conversationId).map((t) => remove(t.id)))
}

/** Byte/row estimate for the Data tab — reads only the index store. */
export async function tracesUsage(): Promise<StoreUsage> {
  const all = await requestOn<TraceIndexRow[]>(INDEX_STORE, 'readonly', (s) => s.getAll())
  return {
    bytes: all.reduce((n, t) => n + t.bytes, 0),
    count: all.length,
    detail: all.length === 1 ? '1 turn' : `${all.length} turns`,
  }
}

/** Wipe every trace (Settings → Data). */
export async function clearTraces(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, INDEX_STORE], 'readwrite')
    tx.objectStore(STORE).clear()
    tx.objectStore(INDEX_STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/** Test-only: drop the database so the next call opens a fresh one. */
export async function _resetTracesForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null)
    db?.close()
  }
  dbPromise = null
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}
