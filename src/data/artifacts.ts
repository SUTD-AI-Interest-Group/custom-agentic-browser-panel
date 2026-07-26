// Agent-created web artifacts (self-contained HTML documents), in their own
// IndexedDB database. Same design as mcpArtifacts.ts and for the same reason:
// the transcript holds only an `artifactId` — a tool's return value lands in
// MODEL history and is re-sent every step, so payloads must never ride it.
//
// Unlike MCP media there is no age-based pruning: an artifact is the user's
// kept work product, not transient media, so only a byte cap protects the
// origin — and the newest artifact always survives, however large.

import { estimateBytes, type StoreUsage } from './usage'

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

const DB_NAME = 'lychee-artifacts'
const DB_VERSION = 1
const STORE = 'artifacts'

const MAX_TOTAL_BYTES = 20 * 1024 * 1024

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

/**
 * Which rows to evict (oldest `updatedAt` first) to get under the byte cap.
 * Pure so it is testable; the newest remaining row is never evicted — the
 * user's latest work survives even if it alone busts the cap.
 */
export function planPrune(
  rows: Array<{ id: string; bytes: number; updatedAt: number }>,
  maxTotalBytes: number,
): string[] {
  const byAge = [...rows].sort((a, b) => a.updatedAt - b.updatedAt)
  let total = byAge.reduce((n, r) => n + r.bytes, 0)
  const evict: string[] = []
  for (const r of byAge) {
    if (total <= maxTotalBytes || evict.length === rows.length - 1) break
    evict.push(r.id)
    total -= r.bytes
  }
  return evict
}

async function prune(): Promise<void> {
  const all = await requestOf<CodeArtifact[]>('readonly', (s) => s.getAll())
  const doomed = planPrune(all, MAX_TOTAL_BYTES)
  await Promise.all(doomed.map((id) => requestOf('readwrite', (s) => s.delete(id))))
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
  await requestOf('readwrite', (s) => s.put(record))
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
  await requestOf('readwrite', (s) => s.put(next))
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
  await Promise.all(doomed.map((a) => requestOf('readwrite', (s) => s.delete(a.id))))
}

export async function clearArtifacts(): Promise<void> {
  await requestOf('readwrite', (s) => s.clear())
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
