// Pure office-document text logic — format detection, the normalized document
// model, and the two char-budget policies that turn it into what the model
// reads. No officeParser, no Chrome: everything here is unit-testable
// (officeText.test.ts). The impure side (lazy-importing the parser, walking its
// AST, caching) lives in office.ts and calls into this.
//
// Sits beside its format in src/platform/ for the same reason pdfText.ts does,
// even though it is pure: it is format mechanics. Provider-delivery routing is a
// separate concern and lives in src/agent/attachmentPlan.ts.

/** An office format we can parse. PDF is deliberately absent — pdf.ts owns it. */
export type OfficeFormat = 'docx' | 'pptx' | 'odt' | 'odp' | 'ods' | 'xlsx' | 'rtf' | 'epub'

/** One readable unit of a prose document: a slide, a chapter, or the body. */
export interface ProseSegment {
  label: string
  text: string
}

/** One sheet of a workbook. `rows` is dense and rectangular after parsing. */
export interface WorkbookSheet {
  name: string
  rows: string[][]
  rowCount: number
  colCount: number
}

/**
 * The normalized model. office.ts produces it, this module consumes it, and
 * nothing else ever sees an officeParser type — which is what makes swapping
 * the parser a one-file change.
 */
export type OfficeDoc =
  | { shape: 'prose'; format: Exclude<OfficeFormat, 'xlsx' | 'ods'>; segments: ProseSegment[]; imageCount: number }
  | { shape: 'workbook'; format: 'xlsx' | 'ods'; sheets: WorkbookSheet[]; imageCount: number }

/** A formatted document, ready to append to the model-facing message text. */
export interface FormattedDoc {
  text: string
  truncated: boolean
  /** Human-readable statement of what was cut, or null when nothing was. */
  note: string | null
}

const EXT_FORMATS: [RegExp, OfficeFormat][] = [
  [/\.docx$/i, 'docx'],
  [/\.pptx$/i, 'pptx'],
  [/\.xlsx$/i, 'xlsx'],
  [/\.odt$/i, 'odt'],
  [/\.odp$/i, 'odp'],
  [/\.ods$/i, 'ods'],
  [/\.rtf$/i, 'rtf'],
  [/\.epub$/i, 'epub'],
]

const MIME_FORMATS: Record<string, OfficeFormat> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'application/epub+zip': 'epub',
}

// Binary Office 97 formats. officeParser cannot read them at all, so they get a
// dedicated message — "unsupported type" is baffling when .docx works.
const LEGACY_EXT = /\.(doc|xls|ppt)$/i
const LEGACY_MIME = new Set(['application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint'])

/** The office format this file is, or null if it belongs on another path. */
export function officeFormatFor(name: string, mimeType: string): OfficeFormat | null {
  for (const [pattern, format] of EXT_FORMATS) {
    if (pattern.test(name)) return format
  }
  return MIME_FORMATS[mimeType] ?? null
}

/** True for .doc/.xls/.ppt — parseable by nothing we ship. */
export function isLegacyOfficeName(name: string, mimeType: string): boolean {
  return LEGACY_EXT.test(name) || LEGACY_MIME.has(mimeType)
}

/**
 * Slice `text[0:end]` without splitting a UTF-16 surrogate pair at the cut.
 * `.slice()` counts code units, so a cut between a pair's halves leaves a lone
 * surrogate, which the provider's UTF-8 encode replaces with U+FFFD.
 *
 * Deliberately a local copy rather than a shared import: attachmentPlan.ts and
 * pdfText.ts each hold their own, and pdf* files are owned by concurrent work.
 * Consolidating all three is a follow-up, not this feature's business.
 */
function safeSlice(text: string, end: number): string {
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) return text.slice(0, end - 1)
  }
  return text.slice(0, Math.max(0, end))
}

/** What one segment is called, per format — used in the chip and the notes. */
function unitNoun(format: OfficeFormat, plural: boolean): string {
  const noun = format === 'pptx' || format === 'odp' ? 'slide'
    : format === 'epub' ? 'chapter'
    : format === 'xlsx' || format === 'ods' ? 'sheet'
    : 'section'
  return plural ? `${noun}s` : noun
}

/** A short human summary for the attachment chip, e.g. "12 slides". */
export function describeOfficeDoc(doc: OfficeDoc): string {
  const n = doc.shape === 'workbook' ? doc.sheets.length : doc.segments.length
  return `${n} ${unitNoun(doc.format, n !== 1)}`
}

/**
 * Prose delivery: segments in reading order under one budget. The segment that
 * crosses the budget is truncated; later segments are omitted and named. Reading
 * order beats fairness inside a document — the opposite of the workbook policy,
 * where sheet 1 must not be allowed to starve sheet 3.
 */
export function formatProse(doc: OfficeDoc, name: string, budget: number): FormattedDoc {
  if (doc.shape !== 'prose') throw new Error('formatProse called with a workbook')
  const header = `--- attached file: ${name} (${describeOfficeDoc(doc)}) ---`
  const footer = `--- end of ${name} ---`

  const withText = doc.segments.filter((s) => s.text.trim().length > 0)
  if (withText.length === 0) {
    // An image-only deck. An empty fence invites the model to answer from
    // nothing; the count makes the gap explicit instead.
    const body = doc.imageCount > 0
      ? `[This document contains no extractable text — it is ${doc.imageCount} image${doc.imageCount === 1 ? '' : 's'}, which cannot be read here.]`
      : '[This document contains no extractable text.]'
    return { text: `${header}\n${body}\n${footer}`, truncated: false, note: null }
  }

  const blocks: string[] = []
  const omitted: string[] = []
  let spent = 0
  let truncated = false
  for (const segment of withText) {
    if (spent >= budget) {
      omitted.push(segment.label)
      continue
    }
    const room = budget - spent
    const cut = segment.text.length > room
    const body = cut ? safeSlice(segment.text, room) : segment.text
    if (cut) truncated = true
    blocks.push(`[${segment.label}]\n${body}`)
    spent += body.length
  }

  const cuts: string[] = []
  if (truncated) cuts.push('the last shown section is truncated')
  if (omitted.length > 0) {
    cuts.push(`${omitted.length} later ${unitNoun(doc.format, omitted.length !== 1)} omitted`)
  }
  const note = cuts.length > 0 ? `[Note: ${cuts.join('; ')} to fit the text budget.]` : null
  const tail = note ? `\n${note}` : ''
  return { text: `${header}\n${blocks.join('\n\n')}${tail}\n${footer}`, truncated: truncated || omitted.length > 0, note }
}
