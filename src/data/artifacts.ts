// Agent-created web artifacts (self-contained HTML documents), in their own
// IndexedDB database. Same design as mcpArtifacts.ts and for the same reason:
// the transcript holds only an `artifactId` — a tool's return value lands in
// MODEL history and is re-sent every step, so payloads must never ride it.
//
// Unlike MCP media there is no age-based pruning: an artifact is the user's
// kept work product, not transient media, so only a byte cap protects the
// origin — and the newest artifact always survives, however large.
//
// A second, lightweight `index` store mirrors `{id, bytes, updatedAt}` for
// every artifact, written inside the SAME transaction as the full record.
// prune() reads ONLY this store: it used to getAll() the full `artifacts`
// store — every artifact's complete HTML document, up to MAX_TOTAL_BYTES
// (20MB) — purely to run the eviction math on three scalar fields, after
// EVERY saveArtifact/updateArtifactContent. UpdateArtifact is the worst case:
// iterative refinement fires it many times in one turn, each time re-reading
// the whole store of full HTML documents just to decide whether to evict. Same
// pattern as conversations.ts's `summaries` store.

import { estimateBytes, planPrune as sharedPlanPrune, type StoreUsage } from './usage'

/** A stored artifact. `html` is always a complete standalone document. */
export interface CodeArtifact {
  id: string
  title: string
  html: string
  /** Bumped by every UpdateArtifact so open cards know to re-render. */
  revision: number
  createdAt: number
  updatedAt: number
  /** The chat that produced it — a deleted conversation takes its artifacts. */
  conversationId: string
  /** Approximate byte size, so pruning need not weigh payloads. */
  bytes: number
}

/** Row shape of the `index` store: just enough for prune()'s eviction math,
 *  denormalized at write time so pruning never has to touch an artifact's HTML. */
interface ArtifactIndexRow {
  id: string
  bytes: number
  updatedAt: number
}

const DB_NAME = 'lychee-artifacts'
const DB_VERSION = 2
const STORE = 'artifacts'
const INDEX_STORE = 'index'

const MAX_TOTAL_BYTES = 20 * 1024 * 1024

let dbPromise: Promise<IDBDatabase> | null = null

function toArtifactIndexRow(a: Pick<CodeArtifact, 'id' | 'bytes' | 'updatedAt'>): ArtifactIndexRow {
  return { id: a.id, bytes: a.bytes, updatedAt: a.updatedAt }
}

/**
 * Stand-in index row for a pre-existing artifact that fails to project during
 * the v1->v2 backfill. `updatedAt: 0` deliberately makes it look oldest rather
 * than fabricating a recency — since this store has no age-based eviction, a
 * degraded row is simply first in line for the byte-cap pass instead of being
 * a zombie the eviction math never weighs.
 */
function degradedArtifactIndexRow(id: string): ArtifactIndexRow {
  return { id, bytes: 0, updatedAt: 0 }
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
          // versionchange transaction, so prune() never has to fall back to
          // the heavy `artifacts` store.
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
                  indexStore.put(toArtifactIndexRow(cursor.value as CodeArtifact))
                } catch (err) {
                  console.error(
                    '[artifacts] malformed row during index backfill — degrading it instead of aborting the upgrade',
                    cursor.primaryKey,
                    err,
                  )
                  indexStore.put(degradedArtifactIndexRow(String(cursor.primaryKey)))
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
 * not be two separate transactions. Used by both saveArtifact and
 * updateArtifactContent, so a revision bump is exactly as atomic as a create.
 */
function putWithIndex(record: CodeArtifact): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE, INDEX_STORE], 'readwrite')
        tx.objectStore(STORE).put(record)
        tx.objectStore(INDEX_STORE).put(toArtifactIndexRow(record))
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

/** Delete an artifact and its index row in one transaction — leaving the index
 *  row behind would have prune() weigh a phantom entry forever. */
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

/**
 * Which rows to evict (oldest `updatedAt` first) to get under the byte cap.
 * Thin wrapper over the shared `planPrune` in usage.ts (also used by
 * screenshots.ts/mcpArtifacts.ts, which additionally prune by age) — kept as
 * its own export, with this file's own field names, since this store has no
 * age-based eviction. The newest remaining row is never evicted — the user's
 * latest work survives even if it alone busts the cap.
 */
export function planPrune(
  rows: Array<{ id: string; bytes: number; updatedAt: number }>,
  maxTotalBytes: number,
): string[] {
  return sharedPlanPrune(
    rows.map((r) => ({ id: r.id, bytes: r.bytes, recency: r.updatedAt })),
    { maxTotalBytes },
  )
}

/**
 * Reads ONLY the lightweight `index` store — never the full `artifacts` store,
 * whose records carry a complete HTML document per artifact, up to
 * MAX_TOTAL_BYTES (20MB). This runs after every saveArtifact AND every
 * updateArtifactContent, and iterative refinement can fire the latter many
 * times in one turn — a getAll() over the heavy store here would mean
 * re-reading the whole store's HTML on every single edit.
 *
 * Exported (unlike this store's other internals) so tests can await its
 * eviction directly rather than racing saveArtifact/updateArtifactContent's
 * fire-and-forget call to it — mirroring pruneShots/pruneMcpArtifacts, which
 * are exported for the same reason.
 */
export async function prune(): Promise<void> {
  const all = await requestOn<ArtifactIndexRow[]>(INDEX_STORE, 'readonly', (s) => s.getAll())
  const doomed = planPrune(all, MAX_TOTAL_BYTES)
  await Promise.all(doomed.map(remove))
}

/** Persist a new artifact; the returned record's id is all the tool result may carry. */
export async function saveArtifact(input: {
  title: string
  html: string
  conversationId: string
}): Promise<CodeArtifact> {
  const now = Date.now()
  const record: CodeArtifact = {
    id: crypto.randomUUID(),
    title: input.title,
    html: input.html,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    conversationId: input.conversationId,
    bytes: input.html.length + input.title.length,
  }
  await putWithIndex(record)
  // Best-effort: a full disk must not fail the tool call the model awaits.
  void prune().catch(() => {})
  return record
}

/** Replace an artifact's content (and optionally title), bumping its revision. */
export async function updateArtifactContent(
  id: string,
  patch: { html: string; title?: string },
): Promise<CodeArtifact | null> {
  const existing = await requestOf<CodeArtifact | undefined>('readonly', (s) => s.get(id))
  if (!existing) return null
  const next: CodeArtifact = {
    ...existing,
    html: patch.html,
    title: patch.title ?? existing.title,
    revision: existing.revision + 1,
    updatedAt: Date.now(),
    bytes: patch.html.length + (patch.title ?? existing.title).length,
  }
  await putWithIndex(next)
  void prune().catch(() => {})
  return next
}

export async function getArtifact(id: string): Promise<CodeArtifact | null> {
  const rec = await requestOf<CodeArtifact | undefined>('readonly', (s) => s.get(id))
  return rec ?? null
}

/** Drop every artifact belonging to a conversation — on chat delete. */
export async function deleteArtifactsForConversation(conversationId: string): Promise<void> {
  const all = await requestOf<CodeArtifact[]>('readonly', (s) => s.getAll())
  const doomed = all.filter((a) => a.conversationId === conversationId)
  await Promise.all(doomed.map((a) => remove(a.id)))
}

/** Wipe every artifact and its index row. */
export async function clearArtifacts(): Promise<void> {
  await requestOf('readwrite', (s) => s.clear())
  await requestOn(INDEX_STORE, 'readwrite', (s) => s.clear())
}

/** Byte/row estimate for the Data tab. */
export async function artifactsUsage(): Promise<StoreUsage> {
  const all = await requestOf<CodeArtifact[]>('readonly', (s) => s.getAll())
  return {
    bytes: estimateBytes(all),
    count: all.length,
    detail: all.length === 1 ? '1 artifact' : `${all.length} artifacts`,
  }
}

/**
 * Test-only: write an artifact record (and its index row) directly — lets
 * prune()'s eviction math be exercised with explicit bytes/updatedAt values
 * without going through saveArtifact/updateArtifactContent.
 */
export async function _putArtifactForTests(artifact: CodeArtifact): Promise<void> {
  await putWithIndex(artifact)
}

/** Test-only: write an artifact's full record WITHOUT its index row —
 *  simulates a pre-existing row from before the `index` store existed. */
export async function _putArtifactWithoutIndexForTests(artifact: CodeArtifact): Promise<void> {
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
