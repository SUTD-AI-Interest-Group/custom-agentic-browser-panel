// Pure translation layer between pdf-inspector's WASM output and the PageText[]
// model the rest of the codebase reads. No Chrome, no WASM, no pdf.js imports —
// everything here is unit-testable (pdfExtract.test.ts).
//
// pdf-inspector returns ONE Markdown string for the whole document, optionally
// interleaved with `<!-- Page N -->` markers. Two conversions matter:
//
//   1. splitPageMarkers  — marker-delimited Markdown back into per-page entries,
//      because every consumer (page ranges, search, budgeting, citations) is
//      addressed by page number.
//   2. stripMarkdown     — a syntax-free twin of each page, because Markdown
//      emphasis lands MID-PHRASE. The Transformer paper renders
//      "Encoder: The encoder is composed of a stack of" as "**Encoder:** The
//      encoder is composed…", so a literal phrase search over the Markdown
//      misses what pdf.js would have found — 249 emphasis runs in that one
//      document, so this is the common case, not an edge case. `plain` is what
//      searchPages matches and snippets on, and what the PDF highlighter
//      normalizes a model-quoted passage through.

import type { PageText } from './pdfText'

/** pdf-inspector's classification of a document. */
export type PdfType = 'TextBased' | 'Scanned' | 'ImageBased' | 'Mixed'

/** The subset of pdf-inspector's `PdfProcessResult` this codebase consumes. */
export interface ExtractResult {
  pdfType: PdfType
  markdown: string
  pageCount: number
  title: string
  pagesNeedingOcr: number[]
  hasEncodingIssues: boolean
}

// Matches the marker pdf-inspector emits under `includePageMarkers: true`. The
// capture group is load-bearing: String.split with a capturing group interleaves
// the captures into the result array, which is how the page numbers survive.
const PAGE_MARKER = /<!--\s*Page\s+(\d+)\s*-->/

/**
 * Split marker-delimited Markdown into per-page entries, 1-based and in order.
 *
 * Always returns exactly `pageCount` entries — a page pdf-inspector emitted no
 * content for still gets an empty entry, matching what the pdf.js path did
 * (it pushed one entry per page regardless). Content before the first marker is
 * folded into page 1 rather than dropped, and a document with no markers at all
 * (a degenerate single-page result) becomes page 1.
 */
export function splitPageMarkers(markdown: string, pageCount: number): string[] {
  const pages: string[] = Array.from({ length: Math.max(0, pageCount) }, () => '')
  if (pageCount <= 0) return pages

  // A capturing split yields [before, n1, text1, n2, text2, …].
  const parts = markdown.split(new RegExp(PAGE_MARKER.source, 'g'))
  const preamble = parts[0]?.trim() ?? ''
  if (parts.length === 1) {
    // No markers at all — the whole document is one page's worth of text.
    pages[0] = preamble
    return pages
  }
  if (preamble) pages[0] = preamble

  for (let i = 1; i < parts.length; i += 2) {
    const n = Number(parts[i])
    const text = (parts[i + 1] ?? '').trim()
    if (!Number.isInteger(n) || n < 1 || n > pageCount) continue
    // Append rather than assign: a preamble already claimed page 1, and a
    // repeated marker should accumulate instead of silently discarding.
    pages[n - 1] = pages[n - 1] ? `${pages[n - 1]}\n\n${text}` : text
  }
  return pages
}

// Emphasis runs must be PAIRED and wrap non-space content, or a lone asterisk in
// the source text ("a * b", a footnote dagger) would be eaten. Ordered longest
// delimiter first so *** is consumed before ** before *.
//
// Every delimiter carries a `(?<!\\)` guard: an ESCAPED delimiter (`\_name\_`)
// is literal text the author wanted, not emphasis, and eating it here would
// leave a stray backslash that the escape pass below can no longer resolve.
const EMPHASIS: [RegExp, string][] = [
  [/(?<!\\)\*\*\*(?=\S)([\s\S]*?\S)(?<!\\)\*\*\*/g, '$1'],
  [/(?<!\\)\*\*(?=\S)([\s\S]*?\S)(?<!\\)\*\*/g, '$1'],
  [/(?<![\w*\\])\*(?=\S)([^*\n]*?\S)(?<!\\)\*(?![\w*])/g, '$1'],
  [/(?<!\\)___(?=\S)([\s\S]*?\S)(?<!\\)___/g, '$1'],
  [/(?<!\\)__(?=\S)([\s\S]*?\S)(?<!\\)__/g, '$1'],
  // `_` guarded on both sides by word chars would be snake_case, not emphasis.
  [/(?<![\w_\\])_(?=\S)([^_\n]*?\S)(?<!\\)_(?![\w_])/g, '$1'],
]

/**
 * Strip Markdown syntax to the text a reader would see, so a phrase quoted from
 * the rendered page still matches. Conservative by design: it removes only
 * unambiguous syntax and leaves the words, spacing, and line structure alone
 * (callers normalize whitespace themselves).
 *
 * List bullets are deliberately KEPT. pdf-inspector normalizes a source bullet
 * to `- `, which matches neither the original glyph nor pdf.js's output, so
 * stripping it would buy nothing — and search phrases essentially never begin
 * at a bullet.
 *
 * INTERLEAVED emphasis inside inline math is also deliberately left alone. A
 * formula comes out as `*warmup**steps*` or `0*.*5`, where the runs cannot be
 * paired unambiguously (is that `*warmup*` + `*steps*`, or one `**` run?). Any
 * choice there is a guess, the surrounding text is math that a model will not
 * quote as a highlight anchor, and pdf.js mangles the same formulas differently
 * anyway — so the paired-only rule declines rather than corrupts. Measured at
 * 4 surviving runs across the 15-page Transformer paper, all of them formulas.
 */
export function stripMarkdown(md: string): string {
  let out = md
  // HTML comments (the page markers themselves, plus image placeholders).
  out = out.replace(/<!--[\s\S]*?-->/g, '')
  // Fenced code: keep the code, drop the fences.
  out = out.replace(/^[ \t]*```[^\n]*\n?/gm, '')
  // Images before links — ![alt](url) would otherwise leave a stray '!'.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // ATX headings and blockquote markers, line-anchored.
  out = out.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  out = out.replace(/^[ \t]*>[ \t]?/gm, '')
  // Table separator rows (|---|:--:|) carry no text at all. The trailing \n goes
  // with them, or every table leaves a blank line where the rule used to be.
  out = out.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$\n?/gm, '')
  for (const [re, to] of EMPHASIS) out = out.replace(re, to)
  // Inline code ticks.
  out = out.replace(/`([^`\n]+)`/g, '$1')
  // Table cell pipes become the space that separated the columns visually.
  out = out.replace(/[ \t]*\|[ \t]*/g, ' ')
  // Backslash escapes markdown added (\*, \_, \|, …).
  out = out.replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, '$1')
  // Trim line by line: the removals above (table pipes especially) leave ragged
  // edges, and this form exists to be MATCHED, where leading indentation is
  // noise — every consumer normalizes whitespace before comparing anyway.
  return out
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Build the PageText[] the rest of the codebase reads, both forms populated. */
export function toPageTexts(markdown: string, pageCount: number): PageText[] {
  return splitPageMarkers(markdown, pageCount).map((text, i) => ({
    page: i + 1,
    text,
    plain: stripMarkdown(text),
  }))
}

/**
 * Turn a pdf-inspector error into the actionable sentence PdfError carries.
 * The WASM throws plain `Error`s prefixed `process PDF: ` with a readable tail
 * (`Not a PDF: file appears to be HTML`, `Invalid PDF structure`, …); this keeps
 * the user-facing wording identical to what the pdf.js path used to produce.
 */
export function pdfErrorMessage(raw: string): string {
  const msg = raw.replace(/^\s*(process|detect|classify) PDF:\s*/i, '').trim()
  const lower = msg.toLowerCase()
  if (lower.includes('password') || lower.includes('encrypt')) {
    return 'This PDF is password-protected and cannot be read.'
  }
  if (lower.includes('file is empty')) {
    return 'This PDF is empty (zero bytes).'
  }
  if (lower.includes('not a pdf')) {
    return lower.includes('html')
      ? 'This URL returned a web page, not a PDF.'
      : 'This file is not a PDF.'
  }
  return `Could not parse this PDF (${msg || 'unknown error'}).`
}

/** Most page numbers one scanned-page note will spell out before summarizing. */
const LIST_CAP = 12

/**
 * The note explaining a document the model cannot read as text. Returns null
 * when nothing is wrong — pdf-inspector's `pagesNeedingOcr` is a real answer,
 * where the old heuristic ("every requested page came back under 20 chars")
 * could only ever guess after the fact.
 */
export function scannedNote(
  result: Pick<ExtractResult, 'pdfType' | 'pagesNeedingOcr' | 'hasEncodingIssues'>,
  requested: number[],
): string | null {
  if (result.hasEncodingIssues) {
    return "This PDF's fonts decode badly, so its text layer is unreliable — use mode:\"view\" to look at a page as an image."
  }
  const needed = new Set(result.pagesNeedingOcr)
  const hit = requested.filter((p) => needed.has(p))
  if (hit.length === 0) return null
  if (hit.length === requested.length) {
    return `${hit.length === 1 ? `Page ${hit[0]} has` : `These pages have`} no text layer — this is a ${result.pdfType === 'Scanned' ? 'scanned' : 'image-based'} document. Use mode:"view" to look at ${hit.length === 1 ? 'it' : 'a page'} as an image.`
  }
  // Cap the list: a mixed 500-page document can need OCR on dozens of pages, and
  // a note that is mostly page numbers costs more than it tells the model.
  const shown = hit.slice(0, LIST_CAP)
  const list = shown.join(', ') + (hit.length > shown.length ? `, and ${hit.length - shown.length} more` : '')
  return `Page${hit.length > 1 ? 's' : ''} ${list} ${hit.length > 1 ? 'have' : 'has'} no text layer — use mode:"view" to look at ${hit.length > 1 ? 'them' : 'it'} as an image.`
}
