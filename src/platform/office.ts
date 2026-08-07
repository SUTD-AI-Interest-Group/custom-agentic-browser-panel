// Office document parsing — the impure shell over officeParser's slim browser
// bundle. Bytes in, the normalized OfficeDoc from officeText.ts out; it never
// formats text. Same division of labour as pdf.ts / pdfText.ts.
//
// Two hard rules live here:
//
// 1. The import is `officeparser/slim` and it is DYNAMIC. The default entry
//    resolves the pdf.js worker and Tesseract language data from jsDelivr at
//    runtime — remotely hosted code, which Manifest V3 forbids and which this
//    product forbids on principle. The slim bundle strips both. Keeping the
//    import dynamic is what makes Vite code-split its ~845 KB into a chunk that
//    loads only when a user actually attaches a document, instead of taxing
//    every panel open.
// 2. decompressionLimits are set on every call. officeParser's defaults (512 MB
//    / 10k entries) are generous enough to let a zip bomb exhaust the panel's
//    memory; these files are untrusted user input.
//
// Runs in page-like contexts (side panel, offscreen host) — never the service
// worker, matching pdf.ts.

import {
  officeFormatFor,
  type OfficeDoc,
  type OfficeFormat,
  type ProseSegment,
  type WorkbookSheet,
} from './officeText'

/** Parse failures the UI shows verbatim — mirrors PdfError. */
export class OfficeError extends Error {}

/** Matches DOCUMENT_MAX_BYTES in attachmentPlan.ts — the parse ceiling. */
export const MAX_OFFICE_BYTES = 25 * 1024 * 1024

// Untrusted archives: well under officeParser's 512 MB / 10k defaults.
const DECOMPRESSION_LIMITS = { maxUncompressedBytes: 64 * 1024 * 1024, maxZipEntries: 2000 }

// A parsed document is reused between attach time (validation) and send time
// (formatting), and a chat may revisit the same attachment across turns. Small,
// because each entry holds the fully-walked document.
const CACHE_MAX = 4
const cache = new Map<string, Promise<OfficeDoc>>()

let parserPromise: Promise<typeof import('officeparser/slim')> | null = null

/** Load the slim bundle once, lazily. Never make this a static import. */
function getOfficeParser(): Promise<typeof import('officeparser/slim')> {
  if (!parserPromise) {
    parserPromise = import('officeparser/slim').catch((err) => {
      // Let a failed load retry on the next attachment rather than poisoning
      // the module for the life of the panel.
      parserPromise = null
      throw new OfficeError(`Could not load the document parser: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  return parserPromise
}

/** Text of one AST node and everything under it. */
function nodeText(node: any): string {
  if (typeof node?.text === 'string' && node.text.length > 0) return node.text
  const kids: any[] = Array.isArray(node?.children) ? node.children : []
  return kids.map(nodeText).join('')
}

/**
 * Rebuild one sheet row by column index. officeParser emits cells sparsely with
 * a 0-based `metadata.col`, so a row that skips B yields two cells — appending
 * them in order would slide C into B's place and misalign every value on that
 * row against the header. Gaps become empty strings instead.
 */
function rowCells(row: any): string[] {
  const cells: any[] = Array.isArray(row?.children) ? row.children : []
  const out: string[] = []
  for (const cell of cells) {
    const col = typeof cell?.metadata?.col === 'number' ? cell.metadata.col : out.length
    while (out.length < col) out.push('')
    out[col] = nodeText(cell)
  }
  return out
}

function toWorkbook(content: any[], format: 'xlsx' | 'ods', imageCount: number): OfficeDoc {
  const sheets: WorkbookSheet[] = content
    .filter((n) => n?.type === 'sheet')
    .map((node) => {
      const rows = (Array.isArray(node.children) ? node.children : [])
        .filter((r: any) => r?.type === 'row')
        .map(rowCells)
      const colCount = rows.reduce((m: number, r: string[]) => Math.max(m, r.length), 0)
      // Pad every row to the widest, so consumers can index columns safely.
      for (const row of rows) while (row.length < colCount) row.push('')
      return { name: String(node.metadata?.sheetName ?? 'Sheet'), rows, rowCount: rows.length, colCount }
    })
  return { shape: 'workbook', format, sheets, imageCount }
}

/**
 * Prose mapping. officeParser's AST is a single flat vocabulary shared by every
 * format it supports — verified empirically (see office.test.ts and the task-3
 * report) against docx/pptx/odt/odp/epub fixtures built with fflate:
 *
 * - pptx and odp both group an entire slide under one top-level `slide` node
 *   (`metadata.slideNumber`, no title field) whose children are walked as a
 *   unit — that grouping is real and this function keys off it.
 * - docx, odt and rtf never group at all: `content` is a flat run of `heading`
 *   / `paragraph` nodes, which is why everything else falls into one running
 *   "Document" body with headings kept inline (`# `-prefixed).
 * - epub ALSO never groups. There is no `chapter` or `section` node anywhere
 *   in officeParser's real type union (`OfficeContentNode` in
 *   officeparser.browser.slim.d.ts) — every spine XHTML file flattens into the
 *   exact same heading/paragraph stream a docx gets, with chapter boundaries
 *   completely invisible in the AST. The nearest real signal is a level-1
 *   heading, which is what EPUB authoring tools put at the top of each chapter
 *   file, so epub alone treats one as a segment boundary and uses its text as
 *   the label. This is a heuristic, not a guarantee: a book that doesn't open
 *   every chapter with an H1 will fall back to fewer, larger segments — never
 *   an error, since `formatProse` handles a single all-encompassing segment
 *   fine.
 */
function toProse(content: any[], format: Exclude<OfficeFormat, 'xlsx' | 'ods'>, imageCount: number): OfficeDoc {
  const segments: ProseSegment[] = []
  let unit = 0
  let label = 'Document'
  let body: string[] = []

  const flush = () => {
    const text = body.join('\n\n')
    if (text.trim().length > 0) segments.push({ label, text })
    body = []
  }

  for (const node of content) {
    if (node?.type === 'slide') {
      flush()
      unit++
      label = `Slide ${unit}`
      const text = (Array.isArray(node.children) ? node.children : []).map(nodeText).join('\n\n')
      if (text.trim().length > 0) body.push(text)
      continue
    }
    if (format === 'epub' && node?.type === 'heading' && node?.metadata?.level === 1) {
      flush()
      unit++
      const text = nodeText(node)
      label = text.trim().length > 0 ? text : `Chapter ${unit}`
      continue
    }
    const text = nodeText(node)
    if (text.trim().length > 0) body.push(node?.type === 'heading' ? `# ${text}` : text)
  }
  flush()
  return { shape: 'prose', format, segments, imageCount }
}

async function doParse(bytes: Uint8Array, name: string, mimeType: string): Promise<OfficeDoc> {
  const format = officeFormatFor(name, mimeType)
  if (!format) throw new OfficeError(`"${name}" is not a supported office document.`)
  const { parseOffice } = await getOfficeParser()
  let ast: any
  try {
    ast = await parseOffice(bytes, { decompressionLimits: DECOMPRESSION_LIMITS })
  } catch (err) {
    throw new OfficeError(
      `Could not read "${name}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const content: any[] = Array.isArray(ast?.content) ? ast.content : []
  const imageCount = Array.isArray(ast?.attachments) ? ast.attachments.length : 0
  return format === 'xlsx' || format === 'ods'
    ? toWorkbook(content, format, imageCount)
    : toProse(content, format, imageCount)
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
