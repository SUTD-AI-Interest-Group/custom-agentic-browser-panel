// Rich content returned by MCP tools (images, audio, video, HTML, downloads),
// in its own IndexedDB database. Same design as screenshots.ts and for the same
// reason: the transcript holds only an `artifactId` — a tool's return value
// lands in MODEL history and is re-sent every step, so payloads must never ride
// it — and the conversations DB must not drag megabytes of media through every
// chat open. Same one-DB-per-store shape as the other data modules.
//
// A second, lightweight `index` store mirrors `{id, bytes, createdAt}` for
// every artifact, written inside the SAME transaction as the full record.
// pruneMcpArtifacts reads ONLY this store: it used to getAll() the full
// `artifacts` store — every dataUrl/text payload, up to MAX_TOTAL_BYTES (50MB)
// — purely to run the eviction math on three scalar fields, after EVERY
// saveMcpArtifact. Same pattern as conversations.ts's `summaries` store.

import { estimateBytes, planPrune, type StoreUsage } from './usage'
import type { McpArtifactInput } from '../mcp/content'

/** A stored MCP artifact. Exactly one of dataUrl/text is set (binary vs text). */
export interface McpArtifact {
  id: string
  kind: McpArtifactInput['kind']
  mimeType: string
  dataUrl?: string
  text?: string
  title: string
  /** Which server/tool produced it, for the card's provenance line. */
  server: string
  tool: string
  createdAt: number
  /** The chat that produced it — a deleted conversation takes its artifacts. */
  conversationId: string
  /** Approximate byte size, so pruning need not decode payloads. */
  bytes: number
}

/** Row shape of the `index` store: just enough for pruneMcpArtifacts' eviction
 *  math, denormalized at write time so pruning never has to touch a payload. */
interface McpIndexRow {
  id: string
  bytes: number
  createdAt: number
}

const DB_NAME = 'lychee-mcp'
const DB_VERSION = 2
const STORE = 'artifacts'
const INDEX_STORE = 'index'

// Self-limiting like screenshots: media accumulates silently.
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

let dbPromise: Promise<IDBDatabase> | null = null

function toMcpIndexRow(a: Pick<McpArtifact, 'id' | 'bytes' | 'createdAt'>): McpIndexRow {
  return { id: a.id, bytes: a.bytes, createdAt: a.createdAt }
}

/**
 * Stand-in index row for a pre-existing artifact that fails to project during
 * the v1->v2 backfill. `createdAt: 0` deliberately makes it look ancient
 * rather than fabricating a recency — the very next age-based prune pass
 * cleans up both this row and the orphaned full record it points at, instead
 * of leaving a zombie neither eviction pass ever weighs.
 */
function degradedMcpIndexRow(id: string): McpIndexRow {
  return { id, bytes: 0, createdAt: 0 }
}

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (event) => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' })
          store.createIndex('createdAt', 'createdAt')
        }
        if (!db.objectStoreNames.contains(INDEX_STORE)) {
          const indexStore = db.createObjectStore(INDEX_STORE, { keyPath: 'id' })
          // Upgrading an install that already has artifacts (oldVersion > 0):
          // backfill an index row for each existing artifact now, in this same
          // versionchange transaction, so pruneMcpArtifacts never has to fall
          // back to the heavy `artifacts` store.
          if (event.oldVersion > 0) {
            const tx = req.transaction
            const cursorReq = tx?.objectStore(STORE).openCursor()
            if (cursorReq) {
              cursorReq.onsuccess = () => {
                const cursor = cursorReq.result
                if (!cursor) return
                // A single bad row must never take down the whole upgrade —
                // see conversations.ts's identical backfill comment for why an
                // uncaught throw here would brick the database at v1 forever.
                try {
                  indexStore.put(toMcpIndexRow(cursor.value as McpArtifact))
                } catch (err) {
                  console.error(
                    '[mcpArtifacts] malformed row during index backfill — degrading it instead of aborting the upgrade',
                    cursor.primaryKey,
                    err,
                  )
                  indexStore.put(degradedMcpIndexRow(String(cursor.primaryKey)))
                }
                cursor.continue()
              }
            }
          }
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

function requestOf<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
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
 * Write an artifact record and its index row in ONE readwrite transaction
 * spanning both stores — see screenshots.ts's putWithIndex for why this must
 * not be two separate transactions.
 */
function putWithIndex(record: McpArtifact): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE, INDEX_STORE], 'readwrite')
        tx.objectStore(STORE).put(record)
        tx.objectStore(INDEX_STORE).put(toMcpIndexRow(record))
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

/** Delete an artifact and its index row in one transaction — leaving the index
 *  row behind would have pruneMcpArtifacts weigh a phantom entry forever. */
function remove(id: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE, INDEX_STORE], 'readwrite')
        tx.objectStore(STORE).delete(id)
        tx.objectStore(INDEX_STORE).delete(id)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

/** Data-URL payloads are base64: 4 chars per 3 bytes. Text counts as-is. */
function approxBytes(a: { dataUrl?: string; text?: string }): number {
  if (a.dataUrl) {
    const comma = a.dataUrl.indexOf(',')
    return Math.round(((a.dataUrl.length - comma - 1) * 3) / 4)
  }
  return a.text?.length ?? 0
}

/** Persist one artifact; the returned id is all the tool result may carry. */
export async function saveMcpArtifact(
  a: McpArtifactInput & { conversationId: string; server: string; tool: string },
): Promise<string> {
  const id = crypto.randomUUID()
  const record: McpArtifact = {
    id,
    kind: a.kind,
    mimeType: a.mimeType,
    ...(a.dataUrl !== undefined ? { dataUrl: a.dataUrl } : {}),
    ...(a.text !== undefined ? { text: a.text } : {}),
    title: a.title,
    server: a.server,
    tool: a.tool,
    createdAt: Date.now(),
    conversationId: a.conversationId,
    bytes: approxBytes(a),
  }
  await putWithIndex(record)
  // Best-effort: a full disk must not fail the tool call the model awaits.
  void pruneMcpArtifacts().catch(() => {})
  return id
}

export async function getMcpArtifact(id: string): Promise<McpArtifact | null> {
  const rec = await requestOf<McpArtifact | undefined>('readonly', (s) => s.get(id))
  return rec ?? null
}

/** Drop every artifact belonging to a conversation — on chat delete. */
export async function deleteMcpArtifactsForConversation(conversationId: string): Promise<void> {
  const all = await requestOf<McpArtifact[]>('readonly', (s) => s.getAll())
  const doomed = all.filter((a) => a.conversationId === conversationId)
  await Promise.all(doomed.map((a) => remove(a.id)))
}

/**
 * Evict oldest-first until under both ceilings (age + total bytes). The
 * byte-cap pass never evicts the single newest survivor — see planPrune — so
 * an oversized artifact (e.g. an MCP tool's returned video/audio) outlives its
 * own very next prune instead of vanishing right after being saved.
 *
 * Reads ONLY the lightweight `index` store — never the full `artifacts` store,
 * whose records carry dataUrl/text payloads up to MAX_TOTAL_BYTES (50MB). This
 * runs after every saveMcpArtifact, so a getAll() over the heavy store here
 * would mean deserializing the whole store's media on every single tool call.
 */
export async function pruneMcpArtifacts(): Promise<{ deleted: number }> {
  const all = await requestOn<McpIndexRow[]>(INDEX_STORE, 'readonly', (s) => s.getAll())
  const doomed = planPrune(
    all.map((a) => ({ id: a.id, bytes: a.bytes, recency: a.createdAt })),
    { maxTotalBytes: MAX_TOTAL_BYTES, maxAgeMs: MAX_AGE_MS },
  )
  await Promise.all(doomed.map(remove))
  return { deleted: doomed.length }
}

/** Wipe every artifact and its index row. */
export async function clearMcpArtifacts(): Promise<void> {
  await requestOf('readwrite', (s) => s.clear())
  await requestOn(INDEX_STORE, 'readwrite', (s) => s.clear())
}

/** Byte/row estimate for the Data tab. */
export async function mcpArtifactsUsage(): Promise<StoreUsage> {
  const all = await requestOf<McpArtifact[]>('readonly', (s) => s.getAll())
  return {
    bytes: estimateBytes(all),
    count: all.length,
    detail: all.length === 1 ? '1 item' : `${all.length} items`,
  }
}

/**
 * Test-only: write an artifact record (and its index row) directly, e.g. with
 * an explicit createdAt saveMcpArtifact can't express, for age-eviction tests.
 */
export async function _putArtifactForTests(artifact: McpArtifact): Promise<void> {
  await putWithIndex(artifact)
}

/** Test-only: write an artifact's full record WITHOUT its index row —
 *  simulates a pre-existing row from before the `index` store existed. */
export async function _putArtifactWithoutIndexForTests(artifact: McpArtifact): Promise<void> {
  await requestOf('readwrite', (s) => s.put(artifact))
}

/** Test-only: close and delete the underlying database so the next call opens
 *  a fresh, empty one. Mirrors vault.ts's resetVault. */
export async function _resetDbForTests(): Promise<void> {
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
