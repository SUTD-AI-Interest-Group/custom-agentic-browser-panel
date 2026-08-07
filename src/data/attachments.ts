// Files the user attached to messages, in their own IndexedDB database
// (extension origin). Kept out of the conversations DB on purpose — the same
// rationale as screenshots.ts: a transcript is loaded in full every time a chat
// is opened, and inline file data would drag megabytes through that read. The
// transcript and the persisted model history hold only references (an
// AttachmentMeta on the UI side, a `lychee-attachment:<id>` sentinel in
// history — see attachmentRefs.ts); the bytes live here once.
//
// Self-limiting like the screenshots store: attachments accumulate silently, so
// a total-size cap and an age cap prune oldest-first after every save. A pruned
// attachment hydrates into an explanatory note, never a broken part.
//
// Same one-DB-per-store shape as conversations.ts / screenshots.ts, so no module
// coordinates schema versions with another.

import type { AttachmentKind } from '../agent/attachmentPlan'
import { estimateBytes, type StoreUsage } from './usage'

/** What the transcript keeps about an attachment — enough to render its chip. */
export interface AttachmentMeta {
  id: string
  kind: AttachmentKind
  name: string
  byteSize: number
  /** PDFs only. */
  pageCount?: number
  /** 240px JPEG preview for image attachments; absent for docs. */
  thumbDataUrl?: string
  /** Office documents only — a short summary like "12 slides" for the chip. */
  docSummary?: string
}

/** A stored attachment. `dataUrl` is the original file, base64-encoded. */
export interface StoredAttachment {
  id: string
  /** The chat it was sent in — lets a deleted conversation take its files with it. */
  conversationId: string
  meta: AttachmentMeta
  dataUrl: string
  createdAt: number
  /** Approximate decoded byte size, so pruning need not decode every record. */
  bytes: number
}

const DB_NAME = 'lychee-attachments'
const DB_VERSION = 1
const STORE = 'attachments'

const MAX_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

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

/** A data URL's payload is base64: 4 chars per 3 bytes. Close enough to prune on. */
export function approxBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  return Math.round(((dataUrl.length - comma - 1) * 3) / 4)
}

/**
 * Store an attachment's original bytes + meta. Called at send time only — an
 * abandoned draft never touches disk. Pruning runs best-effort afterwards.
 */
export async function saveAttachment(a: {
  id: string
  conversationId: string
  meta: AttachmentMeta
  dataUrl: string
}): Promise<void> {
  const record: StoredAttachment = {
    id: a.id,
    conversationId: a.conversationId,
    meta: a.meta,
    dataUrl: a.dataUrl,
    createdAt: Date.now(),
    bytes: approxBytes(a.dataUrl),
  }
  await requestOf('readwrite', (s) => s.put(record))
  // Best-effort: a full disk should not fail the send the user is waiting on.
  void pruneAttachments().catch(() => {})
}

/** The stored record — for history hydration and bubble downloads. */
export async function getAttachment(id: string): Promise<StoredAttachment | null> {
  const rec = await requestOf<StoredAttachment | undefined>('readonly', (s) => s.get(id))
  return rec ?? null
}

/** Drop every attachment belonging to a conversation — called when the chat is deleted. */
export async function deleteAttachmentsForConversation(conversationId: string): Promise<void> {
  const all = await requestOf<StoredAttachment[]>('readonly', (s) => s.getAll())
  const doomed = all.filter((a) => a.conversationId === conversationId)
  await Promise.all(doomed.map((a) => requestOf('readwrite', (s) => s.delete(a.id))))
}

/**
 * Evict oldest-first until the store is under both ceilings. Runs after every
 * save, so the store is bounded without the user ever having to think about it.
 */
export async function pruneAttachments(): Promise<{ deleted: number }> {
  const all = await requestOf<StoredAttachment[]>('readonly', (s) => s.getAll())
  const cutoff = Date.now() - MAX_AGE_MS
  const doomed = new Set(all.filter((a) => a.createdAt < cutoff).map((a) => a.id))

  const survivors = all
    .filter((a) => !doomed.has(a.id))
    .sort((a, b) => b.createdAt - a.createdAt) // newest first
  let running = 0
  for (const a of survivors) {
    running += a.bytes
    if (running > MAX_TOTAL_BYTES) doomed.add(a.id)
  }

  await Promise.all([...doomed].map((id) => requestOf('readwrite', (s) => s.delete(id))))
  return { deleted: doomed.size }
}

/** Wipe every stored attachment. */
export async function clearAttachments(): Promise<void> {
  await requestOf('readwrite', (s) => s.clear())
}

/** Byte/row estimate for the Data tab (base64 text is what IndexedDB holds). */
export async function attachmentsUsage(): Promise<StoreUsage> {
  const all = await requestOf<StoredAttachment[]>('readonly', (s) => s.getAll())
  return {
    bytes: estimateBytes(all),
    count: all.length,
    detail: all.length === 1 ? '1 file' : `${all.length} files`,
  }
}
