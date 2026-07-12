// Storage accounting, as pure functions and shared types.
//
// This is a LEAF: it imports nothing from src/data/. The stores import it to
// report their own size, and storage.ts imports both. Making this file import a
// store would close a cycle, and neither module would compile alone.

/** The five clearable stores, in Data-tab display order. */
export type StoreKey = 'conversations' | 'screenshots' | 'memory' | 'skills' | 'research'

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
