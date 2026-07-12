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
// Same one-DB-per-store shape as conversations.ts / memory.ts, so neither module
// has to coordinate schema versions with the others.

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
}

/** A small preview, kept apart from the multi-megabyte full-resolution record. */
export interface ShotThumb {
  id: string
  thumb: string
  width: number
  height: number
  label: string
}

const DB_NAME = 'lychee-screenshots'
const DB_VERSION = 1
const STORE = 'shots'
const THUMBS = 'thumbs'

// Screenshots accumulate silently and have no user-visible place they would ever
// surface, so they must be self-limiting or they grow without bound.
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Longest side of the thumbnail kept inline in the transcript. */
const THUMB_SIDE = 240

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' })
          store.createIndex('createdAt', 'createdAt')
        }
        if (!db.objectStoreNames.contains(THUMBS)) db.createObjectStore(THUMBS, { keyPath: 'id' })
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
  }
  const thumb: ShotThumb = {
    id,
    thumb: await makeThumb(shot.dataUrl),
    width: shot.width,
    height: shot.height,
    label: shot.label,
  }
  await requestOf('readwrite', (s) => s.put(record))
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

/** Delete an image from both stores; leaving a thumb behind would orphan it. */
function remove(id: string): Promise<unknown> {
  return Promise.all([
    requestOf('readwrite', (s) => s.delete(id)),
    requestOn(THUMBS, 'readwrite', (s) => s.delete(id)),
  ])
}

/**
 * Evict oldest-first until the store is under both ceilings. Runs after every
 * save, so the store is bounded without a user ever having to think about it.
 */
export async function pruneShots(): Promise<{ deleted: number }> {
  const all = await requestOf<StoredShot[]>('readonly', (s) => s.getAll())
  const cutoff = Date.now() - MAX_AGE_MS
  const doomed = new Set(all.filter((s) => s.createdAt < cutoff).map((s) => s.id))

  const survivors = all
    .filter((s) => !doomed.has(s.id))
    .sort((a, b) => b.createdAt - a.createdAt) // newest first
  let running = 0
  for (const s of survivors) {
    running += s.bytes
    if (running > MAX_TOTAL_BYTES) doomed.add(s.id)
  }

  await Promise.all([...doomed].map(remove))
  return { deleted: doomed.size }
}
