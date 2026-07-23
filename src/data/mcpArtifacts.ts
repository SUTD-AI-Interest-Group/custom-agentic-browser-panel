// Rich content returned by MCP tools (images, audio, video, HTML, downloads),
// in its own IndexedDB database. Same design as screenshots.ts and for the same
// reason: the transcript holds only an `artifactId` — a tool's return value
// lands in MODEL history and is re-sent every step, so payloads must never ride
// it — and the conversations DB must not drag megabytes of media through every
// chat open. Same one-DB-per-store shape as the other data modules.

import { estimateBytes, type StoreUsage } from './usage'
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

const DB_NAME = 'lychee-mcp'
const DB_VERSION = 1
const STORE = 'artifacts'

// Self-limiting like screenshots: media accumulates silently.
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
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
  await requestOf('readwrite', (s) => s.put(record))
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
  await Promise.all(doomed.map((a) => requestOf('readwrite', (s) => s.delete(a.id))))
}

/** Evict oldest-first until under both ceilings (age + total bytes). */
export async function pruneMcpArtifacts(): Promise<{ deleted: number }> {
  const all = await requestOf<McpArtifact[]>('readonly', (s) => s.getAll())
  const cutoff = Date.now() - MAX_AGE_MS
  const doomed = new Set(all.filter((a) => a.createdAt < cutoff).map((a) => a.id))
  const survivors = all.filter((a) => !doomed.has(a.id)).sort((x, y) => y.createdAt - x.createdAt)
  let running = 0
  for (const a of survivors) {
    running += a.bytes
    if (running > MAX_TOTAL_BYTES) doomed.add(a.id)
  }
  await Promise.all([...doomed].map((id) => requestOf('readwrite', (s) => s.delete(id))))
  return { deleted: doomed.size }
}

export async function clearMcpArtifacts(): Promise<void> {
  await requestOf('readwrite', (s) => s.clear())
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
