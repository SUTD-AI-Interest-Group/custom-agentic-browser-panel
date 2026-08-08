// Screenshots the agent took, in their own IndexedDB database (extension
// origin). Kept out of the conversations DB on purpose: a transcript is loaded
// in full every time a chat is opened, and a screenshot-heavy chat would drag
// megabytes of PNG through that read.
//
// What the transcript holds is just a `shotId` — nothing more. That is not
// merely a size optimization: a tool's return value goes into the MODEL's
// history and is re-sent on every subsequent step, so an inline thumbnail there
// would cost a couple of thousand tokens per screenshot, forever, for a picture
// the model has already been shown properly as an image part.
//
// Thumbnails live in their own object store rather than on the full record,
// because rendering a 240px preview should not mean reading a 3MB full-page PNG
// off disk and onto the UI thread.
//
// A third, lightweight `index` store mirrors `{id, bytes, createdAt}` for every
// shot, written inside the SAME transaction as the full record. pruneShots
// reads ONLY this store: it used to getAll() the full `shots` store — every
// full-resolution base64 PNG dataUrl deserialized — purely to run the eviction
// math on three scalar fields, after EVERY saveShot. That cost (up to
// MAX_TOTAL_BYTES = 50MB) was paid on the panel's single JS thread on every
// capture. Same pattern as conversations.ts's `summaries` store.
//
// Same one-DB-per-store shape as conversations.ts / memory.ts, so neither module
// has to coordinate schema versions with the others.

import { estimateBytes, planPrune, type StoreUsage } from './usage'

/** A stored capture. `dataUrl` is the full-resolution PNG. */
export interface StoredShot {
  id: string
  dataUrl: string
  width: number
  height: number
  /** Page it came from, for the carousel caption and the download filename. */
  url: string
  title: string
  /** What was captured, e.g. `<figure> "Q3 revenue chart"` or `the full page`. */
  label: string
  createdAt: number
  /** The chat that took it — lets a deleted conversation take its shots with it. */
  conversationId: string
  /** Approximate byte size, so pruning need not decode every image. */
  bytes: number
  /** For a rendered PDF page: its 1-based page number (drives "open page" jumps). */
  page?: number
}

/** A small preview, kept apart from the multi-megabyte full-resolution record. */
export interface ShotThumb {
  id: string
  thumb: string
  width: number
  height: number
  label: string
  /** For a rendered PDF page: its 1-based page number. With `url`, lets the
   *  collapsed card offer an "open page" jump without loading the full record. */
  page?: number
  /** The PDF's URL — set only alongside `page`. */
  url?: string
}

/** Row shape of the `index` store: just enough for pruneShots' eviction math,
 *  denormalized at write time so pruning never has to touch a `dataUrl`. */
interface ShotIndexRow {
  id: string
  bytes: number
  createdAt: number
}

const DB_NAME = 'lychee-screenshots'
const DB_VERSION = 2
const STORE = 'shots'
const THUMBS = 'thumbs'
const INDEX_STORE = 'index'

// Screenshots accumulate silently and have no user-visible place they would ever
// surface, so they must be self-limiting or they grow without bound.
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Longest side of the thumbnail kept inline in the transcript. */
const THUMB_SIDE = 240

let dbPromise: Promise<IDBDatabase> | null = null

function toShotIndexRow(s: Pick<StoredShot, 'id' | 'bytes' | 'createdAt'>): ShotIndexRow {
  return { id: s.id, bytes: s.bytes, createdAt: s.createdAt }
}

/**
 * Stand-in index row for a pre-existing shot that fails to project during the
 * v1->v2 backfill (malformed row from an earlier release or a manual edit).
 * `createdAt: 0` deliberately makes it look ancient rather than fabricating a
 * recency — the very next age-based prune pass cleans up both this row and the
 * orphaned full record it points at, instead of leaving a permanent zombie
 * that never gets weighed by either eviction pass.
 */
function degradedShotIndexRow(id: string): ShotIndexRow {
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
        if (!db.objectStoreNames.contains(THUMBS)) db.createObjectStore(THUMBS, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(INDEX_STORE)) {
          const indexStore = db.createObjectStore(INDEX_STORE, { keyPath: 'id' })
          // Upgrading an install that already has shots (oldVersion > 0):
          // backfill an index row for each existing shot now, in this same
          // versionchange transaction, so pruneShots never has to fall back to
          // the heavy `shots` store.
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
                  indexStore.put(toShotIndexRow(cursor.value as StoredShot))
                } catch (err) {
                  console.error(
                    '[screenshots] malformed row during index backfill — degrading it instead of aborting the upgrade',
                    cursor.primaryKey,
                    err,
                  )
                  indexStore.put(degradedShotIndexRow(String(cursor.primaryKey)))
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

const requestOf = <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
  requestOn(STORE, mode, fn)

/**
 * Write a shot record and its index row in ONE readwrite transaction spanning
 * both stores — they must land together, or a crash mid-write could leave
 * pruneShots' index permanently out of sync with the real record (a phantom
 * index row pointing at nothing, or a full record pruneShots can never see).
 * IndexedDB serialises overlapping readwrite transactions on a store, so one
 * transaction is what makes this atomic; two separate `put`s could interleave
 * with a concurrent prune's delete.
 */
function putWithIndex(record: StoredShot): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE, INDEX_STORE], 'readwrite')
        tx.objectStore(STORE).put(record)
        tx.objectStore(INDEX_STORE).put(toShotIndexRow(record))
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

/** A data URL's payload is base64: 4 chars per 3 bytes. Close enough to prune on. */
function approxBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  return Math.round(((dataUrl.length - comma - 1) * 3) / 4)
}

/** Shrink a PNG data URL to a thumbnail small enough to sit in the transcript. */
export async function makeThumb(dataUrl: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = () => reject(new Error('Failed to decode the screenshot.'))
    i.src = dataUrl
  })
  const scale = Math.min(1, THUMB_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable.')
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  // JPEG, not PNG: the thumbnail is decoration, and PNG would keep it ~5x larger
  // inside a record that is read on every chat open.
  return canvas.toDataURL('image/jpeg', 0.72)
}

/**
 * Store a capture (full image + thumbnail) and return its id — the ONLY thing
 * the caller should put in the tool result, since that lands in model history.
 */
export async function saveShot(shot: {
  dataUrl: string
  width: number
  height: number
  url: string
  title: string
  label: string
  conversationId: string
  /** For a rendered PDF page: its 1-based page number (enables the card's "open page" jump). */
  page?: number
}): Promise<string> {
  const id = crypto.randomUUID()
  const record: StoredShot = {
    id,
    dataUrl: shot.dataUrl,
    width: shot.width,
    height: shot.height,
    url: shot.url,
    title: shot.title,
    label: shot.label,
    createdAt: Date.now(),
    conversationId: shot.conversationId,
    bytes: approxBytes(shot.dataUrl),
    ...(shot.page !== undefined ? { page: shot.page } : {}),
  }
  const thumb: ShotThumb = {
    id,
    thumb: await makeThumb(shot.dataUrl),
    width: shot.width,
    height: shot.height,
    label: shot.label,
    ...(shot.page !== undefined ? { page: shot.page, url: shot.url } : {}),
  }
  await putWithIndex(record)
  await requestOn(THUMBS, 'readwrite', (s) => s.put(thumb))
  // Best-effort: a full disk should not fail the capture the model is waiting on.
  void pruneShots().catch(() => {})
  return id
}

/** The full-resolution image — for the carousel and the download. */
export async function getShot(id: string): Promise<StoredShot | null> {
  const rec = await requestOf<StoredShot | undefined>('readonly', (s) => s.get(id))
  return rec ?? null
}

/** The preview — for the tool card. Reads kilobytes, not megabytes. */
export async function getShotThumb(id: string): Promise<ShotThumb | null> {
  const rec = await requestOn<ShotThumb | undefined>(THUMBS, 'readonly', (s) => s.get(id))
  return rec ?? null
}

/** Drop every shot belonging to a conversation — called when the chat is deleted. */
export async function deleteShotsForConversation(conversationId: string): Promise<void> {
  const all = await requestOf<StoredShot[]>('readonly', (s) => s.getAll())
  const doomed = all.filter((s) => s.conversationId === conversationId)
  await Promise.all(doomed.map((s) => remove(s.id)))
}

/** Delete an image from all three stores; leaving a thumb or index row behind
 *  would orphan it (a stale thumb, or a phantom index row pruneShots would
 *  keep weighing forever against a record that no longer exists). One
 *  transaction so the deletion is atomic across all three. */
function remove(id: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE, THUMBS, INDEX_STORE], 'readwrite')
        tx.objectStore(STORE).delete(id)
        tx.objectStore(THUMBS).delete(id)
        tx.objectStore(INDEX_STORE).delete(id)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

/**
 * Evict oldest-first until the store is under both ceilings. Runs after every
 * save, so the store is bounded without a user ever having to think about it.
 * The byte-cap pass never evicts the single newest survivor — see planPrune —
 * so a capture that alone busts the cap outlives its own very next prune
 * instead of vanishing out from under the card the UI just rendered for it.
 *
 * Reads ONLY the lightweight `index` store — never the full `shots` store, whose
 * records carry full-resolution base64 PNG dataUrls. This runs after every
 * saveShot, so a getAll() over the heavy store here would mean deserializing up
 * to MAX_TOTAL_BYTES (50MB) of image data on the panel's single JS thread on
 * every single capture.
 */
export async function pruneShots(): Promise<{ deleted: number }> {
  const all = await requestOn<ShotIndexRow[]>(INDEX_STORE, 'readonly', (s) => s.getAll())
  const doomed = planPrune(
    all.map((s) => ({ id: s.id, bytes: s.bytes, recency: s.createdAt })),
    { maxTotalBytes: MAX_TOTAL_BYTES, maxAgeMs: MAX_AGE_MS },
  )
  await Promise.all(doomed.map(remove))
  return { deleted: doomed.length }
}

/** Wipe every screenshot, its thumbnail and its index row. */
export async function clearShots(): Promise<void> {
  await requestOf('readwrite', (s) => s.clear())
  await requestOn(THUMBS, 'readwrite', (s) => s.clear())
  await requestOn(INDEX_STORE, 'readwrite', (s) => s.clear())
}

/**
 * Byte/row estimate for the Data tab.
 *
 * Measured from the base64 `dataUrl` string, not each shot's `bytes` field: that
 * field is the *decoded* PNG size, while what IndexedDB actually holds is the
 * base64 text — a third larger. This is the store that dominates the total, so
 * the honest number is the one the user came here to see.
 */
export async function shotsUsage(): Promise<StoreUsage> {
  const shots = await requestOf<StoredShot[]>('readonly', (s) => s.getAll())
  const thumbs = await requestOn<ShotThumb[]>(THUMBS, 'readonly', (s) => s.getAll())
  return {
    bytes: estimateBytes(shots) + estimateBytes(thumbs),
    count: shots.length,
    detail: shots.length === 1 ? '1 image' : `${shots.length} images`,
  }
}

/**
 * Test-only: write a full-resolution shot record (and its index row) directly,
 * bypassing saveShot's makeThumb() — which decodes the image through a real
 * <canvas> that jsdom has no native binding for (getContext always returns
 * null here). Lets pruneShots' eviction math be exercised without a real
 * thumbnail, while still exercising the same store+index write pruneShots
 * actually reads from.
 */
export async function _putShotForTests(shot: StoredShot): Promise<void> {
  await putWithIndex(shot)
}

/** Test-only: write a shot's full record WITHOUT its index row — simulates a
 *  pre-existing row from before the `index` store existed, for migration tests. */
export async function _putShotWithoutIndexForTests(shot: StoredShot): Promise<void> {
  await requestOf('readwrite', (s) => s.put(shot))
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
