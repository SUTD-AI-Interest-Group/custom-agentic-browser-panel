// Pure PDF text logic — URL/byte detection, page-range parsing, keyword search,
// char-budgeted page assembly, outline flattening. No Chrome or pdf.js imports:
// everything here is unit-testable (pdfText.test.ts). The Chrome/pdf.js-coupled
// side (fetching, parsing, rendering) lives in pdf.ts and calls into this.

/**
 * The PDF byte-size ceiling, single-sourced here so pdf.ts's parse gate and
 * attachmentPlan.ts's ingestion gate (PDF_MAX_BYTES) can never drift apart —
 * they used to be two 50 MB literals kept in sync only by a comment, and a
 * mismatch there fails as a confusing partial failure (ingested, then
 * rejected at parse time, or vice versa) rather than a clean rejection.
 * Lives in this pure module (not pdf.ts, which is Chrome-coupled) so
 * attachmentPlan.ts — deliberately Chrome-free — can import it directly.
 */
export const PDF_BYTE_LIMIT = 50 * 1024 * 1024

/** One page's extracted text, 1-based. */
export interface PageText {
  page: number
  /** Markdown, as pdf-inspector produced it — this is what the model reads. */
  text: string
  /**
   * The same page with Markdown syntax stripped (pdfExtract.ts's stripMarkdown).
   * Everything that MATCHES text against the document reads this instead, because
   * emphasis lands mid-phrase: "**Encoder:** The encoder…" makes a literal search
   * for "Encoder: The encoder…" miss. Optional so a test or a caller with plain
   * text can omit it; consumers fall back to `text`.
   */
  plain?: string
}

/** The form to match against — stripped where available, raw otherwise. */
export function matchable(p: PageText): string {
  return p.plain ?? p.text
}

/**
 * Conservative URL heuristic: true only when the path itself ends in `.pdf`
 * (query/hash ignored). Deliberately does NOT match extension-less PDF paths
 * (e.g. arxiv.org/pdf/<id>) — callers that fetch anyway use sniffPdf on the
 * bytes / content-type for those, and a conservative heuristic keeps the
 * ReadPage→ReadPdf hint from misfiring on ordinary pages.
 */
export function looksLikePdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf')
  } catch {
    return false
  }
}

/**
 * True when the bytes carry the `%PDF-` magic within the first 1024 bytes —
 * the PDF spec allows junk before the header, so a small scan window is needed;
 * bounding it keeps a large non-PDF from being scanned wholesale.
 */
export function sniffPdf(bytes: Uint8Array): boolean {
  const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-
  const limit = Math.min(bytes.length, 1024) - MAGIC.length
  outer: for (let i = 0; i <= limit; i++) {
    for (let j = 0; j < MAGIC.length; j++) {
      if (bytes[i + j] !== MAGIC[j]) continue outer
    }
    return true
  }
  return false
}

/**
 * Parse a page-range spec like "3", "3-7", "3-7, 12" into sorted, de-duplicated
 * 1-based page numbers. Reversed ranges are normalized; ranges running past the
 * end are clamped to `pageCount`. A spec that selects nothing in range errors.
 */
export function parsePageRange(
  spec: string,
  pageCount: number,
): { pages: number[] } | { error: string } {
  const parts = spec.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return { error: 'Empty page range. Use e.g. "3", "3-7", or "3-7,12".' }
  const picked = new Set<number>()
  for (const part of parts) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/)
    if (!m) return { error: `Bad page range "${part}". Use e.g. "3", "3-7", or "3-7,12".` }
    let lo = Number(m[1])
    let hi = m[2] !== undefined ? Number(m[2]) : lo
    if (lo > hi) [lo, hi] = [hi, lo]
    if (lo < 1) return { error: `Pages are numbered from 1 (got "${part}").` }
    for (let p = lo; p <= Math.min(hi, pageCount); p++) picked.add(p)
  }
  if (picked.size === 0) {
    return { error: `No such pages — this PDF has ${pageCount} page${pageCount === 1 ? '' : 's'}.` }
  }
  return { pages: [...picked].sort((a, b) => a - b) }
}

/** One page's search hit: how many times the query occurs and one snippet around the first occurrence. */
/**
 * Slice `text[start:end]` without splitting a UTF-16 surrogate pair at either
 * cut — `.slice()` counts code units, not code points, so a cut landing
 * between a pair's two halves leaves a lone surrogate at that edge. The
 * byte-level UTF-8 encode a provider performs on the request replaces a lone
 * surrogate with U+FFFD, so nudge each boundary inward by one rather than
 * send a corrupted character.
 */
function safeSlice(text: string, start: number, end: number): string {
  let s = start
  if (s > 0 && s < text.length) {
    const code = text.charCodeAt(s)
    if (code >= 0xdc00 && code <= 0xdfff) s += 1 // lone low surrogate at the start -> drop it
  }
  let e = end
  if (e > 0 && e < text.length) {
    const code = text.charCodeAt(e - 1)
    if (code >= 0xd800 && code <= 0xdbff) e -= 1 // lone high surrogate at the end -> drop it
  }
  return text.slice(s, e)
}

export interface PdfSearchMatch {
  page: number
  count: number
  snippet: string
}

export interface PdfSearchResult {
  /** All occurrences across all pages (not capped). */
  totalMatches: number
  /** One entry per matching page, capped at `maxPages`. */
  matches: PdfSearchMatch[]
  /** True when more pages matched than `matches` shows. */
  capped: boolean
}

const SEARCH_MAX_PAGES = 40
const SNIPPET_RADIUS = 80

/**
 * Case-insensitive literal search across page texts. Whitespace is normalized
 * on both sides so a phrase matches across line breaks. Returns one entry per
 * matching page (count + a snippet around the first occurrence), capped.
 *
 * Matches AND snippets on the stripped form (`matchable`), never the Markdown:
 * a snippet carrying `**` would be quoted back by the model to HighlightContent
 * and fail to match the rendered page.
 */
export function searchPages(
  pages: PageText[],
  query: string,
  opts?: { maxPages?: number },
): PdfSearchResult | { error: string } {
  const needle = query.trim().replace(/\s+/g, ' ').toLowerCase()
  if (!needle) return { error: 'Empty search query.' }
  const maxPages = opts?.maxPages ?? SEARCH_MAX_PAGES
  const matches: PdfSearchMatch[] = []
  let totalMatches = 0
  let matchingPages = 0
  for (const entry of pages) {
    const { page } = entry
    const haystack = matchable(entry).replace(/\s+/g, ' ')
    const lower = haystack.toLowerCase()
    let count = 0
    let first = -1
    for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + needle.length)) {
      if (count === 0) first = i
      count++
    }
    if (count === 0) continue
    totalMatches += count
    matchingPages++
    if (matches.length < maxPages) {
      const start = Math.max(0, first - SNIPPET_RADIUS)
      const end = Math.min(haystack.length, first + needle.length + SNIPPET_RADIUS)
      const snippet =
        (start > 0 ? '…' : '') + safeSlice(haystack, start, end).trim() + (end < haystack.length ? '…' : '')
      matches.push({ page, count, snippet })
    }
  }
  return { totalMatches, matches, capped: matchingPages > matches.length }
}

export interface AssembledPages {
  blocks: { page: number; text: string; truncated: boolean }[]
  /** Requested pages dropped because the budget ran out before them. */
  omittedPages: number[]
}

/**
 * Assemble the requested pages' text under a total char budget, in order. The
 * page that crosses the budget is truncated (flagged); later pages land in
 * `omittedPages` so the caller can say exactly what was cut rather than
 * truncating silently.
 */
export function assemblePagesText(
  pages: PageText[],
  wanted: number[],
  budget: number,
): AssembledPages {
  const byPage = new Map(pages.map((p) => [p.page, p.text]))
  const blocks: AssembledPages['blocks'] = []
  const omittedPages: number[] = []
  let spent = 0
  for (const page of wanted) {
    const text = byPage.get(page)
    if (text === undefined) continue
    if (spent >= budget) {
      omittedPages.push(page)
      continue
    }
    const room = budget - spent
    const truncated = text.length > room
    const slice = truncated ? safeSlice(text, 0, room) : text
    blocks.push({ page, text: slice, truncated })
    spent += slice.length
  }
  return { blocks, omittedPages }
}

/** A bookmark entry as pdf.ts hands it over: destination already resolved to a 1-based page (or undefined). */
export interface OutlineNode {
  title: string
  page?: number
  items?: OutlineNode[]
}

export interface OutlineEntry {
  title: string
  page?: number
  depth: number
}

const OUTLINE_CAP = 100

/** Flatten a nested bookmark tree depth-first, recording nesting depth, dropping untitled nodes, capped. */
export function flattenOutline(nodes: OutlineNode[], cap = OUTLINE_CAP): OutlineEntry[] {
  const out: OutlineEntry[] = []
  const walk = (list: OutlineNode[], depth: number) => {
    for (const n of list) {
      if (out.length >= cap) return
      if (n.title.trim()) out.push({ title: n.title, page: n.page, depth })
      if (n.items?.length) walk(n.items, depth + 1)
    }
  }
  walk(nodes, 0)
  return out.slice(0, cap)
}
