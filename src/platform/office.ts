// Office document parsing — the thin, panel-resident client over
// officeEngine.ts. This file used to run officeParser inline on the main
// thread; it now only holds the size gate and the LRU parse cache, and hands
// the actual work to the worker (see officeEngine.ts / officeWorker.ts /
// officeParse.ts for why, and officeCellBudget.ts for the XLSX cell-count
// decompression-bomb guard those files apply before the real parse runs).
//
// Runs in page-like contexts (side panel, offscreen host) — never the service
// worker, matching pdf.ts.

import { OfficeError, OFFICE_BYTE_LIMIT, type OfficeDoc } from './officeText'
import { getOfficeEngine } from './officeEngine'

// Re-exported for backward compatibility: attachments.ts imports both
// `parseOfficeDocument` and `OfficeError` from this module, and office.test.ts
// imports `countImageNodes` from it too (its AST-walking home is officeText.ts
// now, alongside toWorkbook/toProse, since none of it needs Chrome/a Worker).
export { OfficeError }
export { countImageNodes } from './officeText'

/**
 * The parse-time gate; single-sourced with attachmentPlan.ts's ingestion-time
 * gate as OFFICE_BYTE_LIMIT in officeText.ts. See that constant's comment.
 */
export const MAX_OFFICE_BYTES = OFFICE_BYTE_LIMIT

// A parsed document is reused between attach time (validation) and send time
// (formatting), and a chat may revisit the same attachment across turns. Small,
// because each entry holds the fully-walked document.
const CACHE_MAX = 4
const cache = new Map<string, Promise<OfficeDoc>>()

async function doParse(bytes: Uint8Array, name: string, mimeType: string): Promise<OfficeDoc> {
  try {
    return await getOfficeEngine().parse(bytes, name, mimeType)
  } catch (err) {
    // The worker already turns a real parse failure into an actionable
    // sentence (officeParse.ts); anything else here is an engine/transport
    // fault (boot failure, wedge timeout). Re-wrapped as a fresh OfficeError
    // so `instanceof OfficeError` at the call site (attachments.ts) sees the
    // right class — a custom Error subclass does not survive the worker's
    // postMessage structured clone, so the worker's own OfficeError instance
    // never actually crosses the boundary; this reconstructs it on this side.
    throw new OfficeError(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Parse an office document, memoized by attachment id so the attach-time parse
 * (which doubles as validation) is reused at send time.
 */
export function parseOfficeDocument(
  bytes: Uint8Array,
  id: string,
  name: string,
  mimeType: string,
): Promise<OfficeDoc> {
  if (bytes.byteLength > MAX_OFFICE_BYTES) {
    return Promise.reject(new OfficeError(`"${name}" is larger than the 25 MB document limit.`))
  }
  const hit = cache.get(id)
  if (hit) {
    // Refresh recency: Map insertion order is the LRU.
    cache.delete(id)
    cache.set(id, hit)
    return hit
  }
  const entry = doParse(bytes, name, mimeType).catch((err) => {
    // A failed parse must not be cached — the user may re-attach a fixed file.
    cache.delete(id)
    throw err
  })
  cache.set(id, entry)
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return entry
}
