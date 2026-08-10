// Storage accounting, as pure functions and shared types.
//
// This is a LEAF: it imports nothing from src/data/. The stores import it to
// report their own size, and storage.ts imports both. Making this file import a
// store would close a cycle, and neither module would compile alone.

/** The clearable stores, in Data-tab display order. */
export type StoreKey =
  | 'conversations'
  | 'screenshots'
  | 'attachments'
  | 'mcp'
  | 'artifacts'
  | 'memory'
  | 'skills'
  | 'research'
  | 'traces'

export interface StoreUsage {
  /** Estimated bytes — see `estimateBytes`. */
  bytes: number
  /** Primary row count (chats, images, memories, skills, reports). */
  count: number
  /** Secondary line, e.g. "6 skills · 2 custom". */
  detail?: string
}

export interface StorageReport {
  /**
   * Sum of the per-store estimates. Deliberately NOT
   * `navigator.storage.estimate().usage`: that figure is origin-wide, includes
   * IndexedDB's own overhead and excludes chrome.storage.local, so the rows would
   * never add up to it — and a total that disagrees with its own rows reads as a
   * bug. The rows are what we can honestly account for; the quota below is the
   * only part we borrow from the browser.
   */
  total: number
  /** Origin quota from navigator.storage.estimate(), or null when unavailable. */
  quota: number | null
  stores: Record<StoreKey, StoreUsage>
}

/**
 * Rough byte size of a stored record: string lengths plus fixed widths for
 * scalars. An estimate, not an audit — structured-clone encoding and IndexedDB
 * overhead are not modelled, and a non-ASCII character counts as one byte where
 * UTF-8 would spend more.
 *
 * That imprecision is fine for the job. This number exists to answer "what is
 * eating my space", and the answer is always screenshots — which are base64 data
 * URLs, i.e. exactly the case where one char really is one byte.
 */
export function estimateBytes(value: unknown): number {
  if (value === null || value === undefined) return 0
  switch (typeof value) {
    case 'string':
      return value.length
    case 'number':
      return 8
    case 'boolean':
      return 4
    case 'object':
      break
    default:
      return 0
  }
  if (Array.isArray(value)) {
    let n = 0
    for (const v of value) n += estimateBytes(v)
    return n
  }
  let n = 0
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    n += k.length + estimateBytes(v)
  }
  return n
}

/**
 * Which rows to evict to satisfy an age ceiling and/or a byte-cap ceiling.
 * Shared by every self-limiting store (screenshots, mcpArtifacts, artifacts) so
 * the "never evict the last survivor" guard below is written — and tested —
 * exactly once instead of drifting across near-identical copies.
 *
 * Two independent passes:
 *  1. Age: anything older than `maxAgeMs` (if given) is doomed unconditionally,
 *     even down to the last row — a store of nothing but ancient rows is
 *     allowed to end up empty.
 *  2. Byte cap: among the age-survivors, evict oldest-`recency`-first until
 *     the remaining total is under `maxTotalBytes` — but NEVER the single
 *     newest survivor, so a capture/artifact that alone busts the cap is not
 *     deleted the moment after it was saved (the caller had just handed its id
 *     back to the UI as "saved successfully").
 *
 * Pure so it is directly testable without any IndexedDB plumbing.
 */
export function planPrune(
  rows: Array<{ id: string; bytes: number; recency: number }>,
  opts: { maxTotalBytes: number; maxAgeMs?: number; now?: number },
): string[] {
  const now = opts.now ?? Date.now()
  const agedOut = opts.maxAgeMs === undefined ? [] : rows.filter((r) => r.recency < now - opts.maxAgeMs!)
  const agedOutIds = new Set(agedOut.map((r) => r.id))
  const pool = rows.filter((r) => !agedOutIds.has(r.id))

  // Oldest-recency-first, so the byte-cap pass below evicts the oldest
  // survivors first and stops one short of emptying the pool.
  const byAge = [...pool].sort((a, b) => a.recency - b.recency)
  let total = byAge.reduce((n, r) => n + r.bytes, 0)
  const byteEvicted: string[] = []
  for (const r of byAge) {
    if (total <= opts.maxTotalBytes || byteEvicted.length === pool.length - 1) break
    byteEvicted.push(r.id)
    total -= r.bytes
  }
  return [...agedOut.map((r) => r.id), ...byteEvicted]
}

/** Human-readable byte size for the Data tab. */
export function formatBytes(n: number): string {
  const KB = 1024
  const MB = KB * 1024
  const GB = MB * 1024
  if (n < KB) return `${n} B`
  if (n < MB) return `${(n / KB).toFixed(1)} KB`
  if (n < GB) return `${(n / MB).toFixed(1)} MB`
  return `${(n / GB).toFixed(2)} GB`
}
