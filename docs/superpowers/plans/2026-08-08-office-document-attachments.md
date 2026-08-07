# Office Document Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users attach docx, pptx, xlsx, odt, odp, ods, rtf and epub files to a chat message, delivered to the model as budgeted text.

**Architecture:** A new pure module (`src/platform/officeText.ts`) owns the normalized document model and all formatting/budget logic; a new impure shell (`src/platform/office.ts`) lazy-imports officeParser's slim browser bundle and maps its AST onto that model. `planAttachmentDelivery` gains one `'document-text'` route. The existing PDF, image and text paths are untouched.

**Tech Stack:** TypeScript (strict), officeParser 7.5.1 (`officeparser/slim`), fflate (test fixtures only), Vitest, React 18.

**Spec:** `docs/superpowers/specs/2026-08-08-office-document-attachments-design.md`

## Global Constraints

- **Code style, enforced by hand (no linter):** no semicolons (ASI), single quotes, 2-space indent, `interface` for object shapes and `type` for unions, `/** … */` on exported types and functions, block comments explaining non-obvious *why*.
- **Only `officeparser/slim` may be imported.** Never the default entry — it resolves the pdf.js worker and Tesseract language data from jsDelivr at runtime, which the no-remote-code constraint forbids.
- **The officeParser import must be dynamic** (`await import('officeparser/slim')`) so Vite code-splits it. A static import inlines 845 KB into `sidepanel.js` and silently breaks the acceptance check in Task 7.
- **`decompressionLimits`: `{ maxUncompressedBytes: 64 * 1024 * 1024, maxZipEntries: 2000 }`** on every `parseOffice` call.
- **Per-file cap 25 MB; char budget 48,000.**
- **Do not modify `src/platform/pdf.ts`, `pdfText.ts`, `pdfExtract.ts`, `pdfEngine.ts` or `pdfWorker.ts`.** A concurrent session owns those files (commit `95d3a58`).
- **Formats routed to officeParser:** docx, pptx, xlsx, odt, odp, ods, rtf, epub. **PDF stays on `pdf.ts`. `.csv`, `.md`, `.html`, `.txt` stay on `inline-text`.**
- Run `npm run typecheck` before every commit. Do not use `npx tsc` — it fetches an unrelated package.
- Commits: no `Co-Authored-By` or `Generated-with` trailers.

---

### Task 1: Normalized model, prose formatting, and shared helpers

**Files:**
- Create: `src/platform/officeText.ts`
- Test: `src/platform/officeText.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `OfficeFormat`, `OfficeDoc`, `ProseSegment`, `WorkbookSheet`, `FormattedDoc`, `officeFormatFor(name, mimeType)`, `isLegacyOfficeName(name, mimeType)`, `formatProse(doc, name, budget)`, `describeOfficeDoc(doc)`.

- [ ] **Step 1: Write the failing test**

Create `src/platform/officeText.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  officeFormatFor,
  isLegacyOfficeName,
  formatProse,
  describeOfficeDoc,
  type OfficeDoc,
} from './officeText'

const prose = (segments: { label: string; text: string }[], imageCount = 0): OfficeDoc => ({
  shape: 'prose',
  format: 'docx',
  segments,
  imageCount,
})

describe('officeFormatFor', () => {
  it('detects each supported extension', () => {
    expect(officeFormatFor('a.docx', '')).toBe('docx')
    expect(officeFormatFor('a.pptx', '')).toBe('pptx')
    expect(officeFormatFor('a.xlsx', '')).toBe('xlsx')
    expect(officeFormatFor('a.odt', '')).toBe('odt')
    expect(officeFormatFor('a.odp', '')).toBe('odp')
    expect(officeFormatFor('a.ods', '')).toBe('ods')
    expect(officeFormatFor('a.rtf', '')).toBe('rtf')
    expect(officeFormatFor('a.epub', '')).toBe('epub')
  })

  it('detects by MIME when the name has no extension', () => {
    expect(
      officeFormatFor('download', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('docx')
  })

  it('is case-insensitive', () => {
    expect(officeFormatFor('REPORT.DOCX', '')).toBe('docx')
  })

  it('returns null for formats that stay on other paths', () => {
    expect(officeFormatFor('a.pdf', 'application/pdf')).toBeNull()
    expect(officeFormatFor('a.csv', 'text/csv')).toBeNull()
    expect(officeFormatFor('a.md', '')).toBeNull()
    expect(officeFormatFor('a.html', 'text/html')).toBeNull()
  })
})

describe('isLegacyOfficeName', () => {
  it('flags binary Office 97 formats', () => {
    expect(isLegacyOfficeName('old.doc', '')).toBe(true)
    expect(isLegacyOfficeName('old.xls', '')).toBe(true)
    expect(isLegacyOfficeName('old.ppt', '')).toBe(true)
    expect(isLegacyOfficeName('deck.ppt', 'application/vnd.ms-powerpoint')).toBe(true)
  })

  it('does not flag the modern equivalents', () => {
    expect(isLegacyOfficeName('new.docx', '')).toBe(false)
    expect(isLegacyOfficeName('new.xlsx', '')).toBe(false)
  })
})

describe('formatProse', () => {
  it('emits every segment under budget with its label', () => {
    const out = formatProse(prose([
      { label: 'Slide 1', text: 'Intro' },
      { label: 'Slide 2', text: 'Detail' },
    ]), 'deck.pptx', 1000)
    expect(out.text).toContain('Slide 1')
    expect(out.text).toContain('Intro')
    expect(out.text).toContain('Slide 2')
    expect(out.truncated).toBe(false)
  })

  it('truncates the crossing segment and names omitted ones', () => {
    const out = formatProse(prose([
      { label: 'A', text: 'x'.repeat(40) },
      { label: 'B', text: 'y'.repeat(40) },
      { label: 'C', text: 'z'.repeat(40) },
    ]), 'doc.docx', 50)
    expect(out.truncated).toBe(true)
    expect(out.text).not.toContain('z'.repeat(40))
    expect(out.note).toMatch(/2 later section/)
  })

  it('never splits a surrogate pair at the cut', () => {
    // '😀' is one astral char = two UTF-16 code units. A budget landing between
    // them would leave a lone high surrogate, which a UTF-8 encode turns into
    // U+FFFD on the wire.
    //
    // Search the WHOLE string for an unpaired high surrogate. Anchoring to `$`
    // would assert nothing: formatProse appends the note and footer after the
    // truncated body, so the cut point is never the last character and a broken
    // safeSlice would leave its lone surrogate mid-string, passing silently.
    const out = formatProse(prose([{ label: 'A', text: '😀'.repeat(10) }]), 'd.docx', 15)
    expect(out.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('reports images instead of an empty block when there is no text', () => {
    const out = formatProse(prose([], 12), 'deck.pptx', 1000)
    expect(out.text).toContain('12 image')
    expect(out.text).not.toMatch(/---\s*---/)
  })
})

describe('describeOfficeDoc', () => {
  it('names the unit per format', () => {
    expect(describeOfficeDoc(prose([{ label: 'Slide 1', text: 'a' }]))).toBe('1 slide')
    expect(
      describeOfficeDoc({ ...prose([{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }]), format: 'epub' }),
    ).toBe('2 chapters')
    expect(
      describeOfficeDoc({ shape: 'workbook', format: 'xlsx', imageCount: 0, sheets: [
        { name: 'Q1', rows: [], rowCount: 0, colCount: 0 },
      ] }),
    ).toBe('1 sheet')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/platform/officeText.test.ts`
Expected: FAIL — `Failed to resolve import "./officeText"`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/officeText.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/platform/officeText.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/platform/officeText.ts src/platform/officeText.test.ts
git commit -m "feat(office): normalized document model and prose text budgeting"
```

---

### Task 2: Workbook formatting — manifest and fair-share rows

**Files:**
- Modify: `src/platform/officeText.ts` (append)
- Test: `src/platform/officeText.test.ts` (append)

**Interfaces:**
- Consumes: `OfficeDoc`, `WorkbookSheet`, `FormattedDoc`, `describeOfficeDoc` from Task 1.
- Produces: `planSheetBudget(sizes, budget)`, `toCsvRow(cells)`, `formatWorkbook(doc, name, budget)`, `formatOfficeDoc(doc, name, budget)`.

- [ ] **Step 1: Write the failing test**

Append to `src/platform/officeText.test.ts`:

```ts
import { planSheetBudget, toCsvRow, formatWorkbook, formatOfficeDoc } from './officeText'

const sheet = (name: string, rows: string[][]): WorkbookSheet => ({
  name,
  rows,
  rowCount: rows.length,
  colCount: rows.reduce((m, r) => Math.max(m, r.length), 0),
})

const book = (sheets: WorkbookSheet[]): OfficeDoc => ({
  shape: 'workbook',
  format: 'xlsx',
  sheets,
  imageCount: 0,
})

describe('planSheetBudget', () => {
  it('gives every sheet its full size when the budget covers all', () => {
    expect(planSheetBudget([10, 20, 30], 1000)).toEqual([10, 20, 30])
  })

  it('redistributes a small sheet surplus to the sheets that want more', () => {
    // Equal share is 50 each. The 10-sheet uses 10, freeing 40 for the others.
    const alloc = planSheetBudget([10, 500, 500], 150)
    expect(alloc[0]).toBe(10)
    expect(alloc[1]).toBe(70)
    expect(alloc[2]).toBe(70)
    expect(alloc[0] + alloc[1] + alloc[2]).toBeLessThanOrEqual(150)
  })

  it('redistributes across multiple rounds, not just once', () => {
    // Round 1 (share 25): only sheet0 (5) fits, freeing 20.
    // Round 2 (share 31): sheet1 (30) now fits — it did NOT in round 1.
    // Round 3 (share 32): the two big sheets split what is left.
    // A single-pass implementation stops after round 1 and caps sheet1 at 25,
    // silently dropping rows it had room for.
    const alloc = planSheetBudget([5, 30, 1000, 1000], 100)
    expect(alloc).toEqual([5, 30, 32, 32])
  })

  it('splits evenly when no sheet is satisfiable', () => {
    expect(planSheetBudget([1000, 1000], 100)).toEqual([50, 50])
  })

  it('allocates nothing when the budget is exhausted', () => {
    expect(planSheetBudget([100, 100], 0)).toEqual([0, 0])
  })
})

describe('toCsvRow', () => {
  it('leaves plain cells bare', () => {
    expect(toCsvRow(['a', 'b'])).toBe('a,b')
  })

  it('quotes cells containing a comma, quote, or newline', () => {
    expect(toCsvRow(['x,y'])).toBe('"x,y"')
    expect(toCsvRow(['say "hi"'])).toBe('"say ""hi"""')
    expect(toCsvRow(['line1\nline2'])).toBe('"line1\nline2"')
  })
})

describe('formatWorkbook', () => {
  it('lists every sheet in the manifest even when rows are cut', () => {
    const big = sheet('Q1', Array.from({ length: 500 }, (_, i) => [`r${i}`, 'APAC', '120']))
    const small = sheet('Notes', [['Topic', 'Detail'], ['Scope', 'FY26']])
    const out = formatWorkbook(book([big, small]), 'sales.xlsx', 400)
    expect(out.text).toContain('Q1')
    expect(out.text).toContain('Notes')
    expect(out.text).toContain('500 rows')
    expect(out.truncated).toBe(true)
  })

  it('keeps a small sheet visible beside a huge one', () => {
    const big = sheet('Q1', Array.from({ length: 5000 }, (_, i) => [`row${i}`, 'data']))
    const small = sheet('Notes', [['Topic', 'Detail'], ['Scope', 'FY26']])
    const out = formatWorkbook(book([big, small]), 'sales.xlsx', 600)
    expect(out.text).toContain('Scope')
  })

  it('states the shown row range against the true total', () => {
    // Budget 200 leaves ~140 chars for rows after the manifest — comfortably
    // more than one row and comfortably less than all 100, so the assertion
    // does not sit on a knife edge against the manifest's exact length.
    const s = sheet('Q1', Array.from({ length: 100 }, (_, i) => [`r${i}`]))
    const out = formatWorkbook(book([s]), 'w.xlsx', 200)
    expect(out.text).toMatch(/rows 1–\d+ of 100/)
    expect(out.truncated).toBe(true)
  })

  it('emits the manifest for an entirely empty workbook', () => {
    const out = formatWorkbook(book([sheet('A', []), sheet('B', [])]), 'empty.xlsx', 500)
    expect(out.text).toContain('A')
    expect(out.text).toContain('B')
    expect(out.text).toContain('0 rows')
  })
})

describe('formatOfficeDoc', () => {
  it('dispatches on shape', () => {
    expect(formatOfficeDoc(book([sheet('A', [['x']])]), 'a.xlsx', 500).text).toContain('workbook')
    expect(formatOfficeDoc(prose([{ label: 'A', text: 'hello' }]), 'a.docx', 500).text).toContain('hello')
  })
})
```

Also add `type WorkbookSheet` to the existing import at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/platform/officeText.test.ts`
Expected: FAIL — `planSheetBudget is not a function` (and siblings).

- [ ] **Step 3: Write the implementation**

Append to `src/platform/officeText.ts`:

```ts
/** Column headers shown per sheet in the manifest. */
const HEADER_PREVIEW = 8

/**
 * Max-min fair allocation of `budget` across sheets wanting `sizes` chars.
 *
 * Equal shares, then any share a small sheet does not use is redistributed to
 * the sheets that want more — repeatedly, until no sheet is under-using its
 * share. A single pass would strand the second-smallest sheet's surplus. This
 * is what keeps a 12-row Notes sheet visible beside a 5,000-row Q1: a purely
 * sequential budget (the prose policy) would spend everything on Q1 and the
 * model would never learn Notes exists.
 */
export function planSheetBudget(sizes: number[], budget: number): number[] {
  const alloc = new Array<number>(sizes.length).fill(0)
  let pending = sizes.map((_, i) => i)
  let remaining = budget
  while (pending.length > 0) {
    const share = Math.floor(remaining / pending.length)
    if (share <= 0) break
    const satisfied = pending.filter((i) => sizes[i] <= share)
    if (satisfied.length === 0) {
      // Nobody fits: split what is left evenly and stop.
      for (const i of pending) alloc[i] = share
      break
    }
    for (const i of satisfied) {
      alloc[i] = sizes[i]
      remaining -= sizes[i]
    }
    pending = pending.filter((i) => sizes[i] > share)
  }
  return alloc
}

/** One CSV row, quoting only cells that need it (RFC 4180). */
export function toCsvRow(cells: string[]): string {
  return cells
    .map((cell) => (/[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
    .join(',')
}

/**
 * Workbook delivery: a manifest of every sheet first — names, dimensions and
 * headers — then as many CSV rows as the fair-share budget allows.
 *
 * The manifest is never truncated. It is small and bounded, and it is the thing
 * that must survive: knowing sheet 3 exists and what its columns are is worth
 * more than another hundred rows of sheet 1. Rows go out as CSV rather than
 * Markdown tables — markedly fewer tokens per cell for the same information.
 */
export function formatWorkbook(doc: OfficeDoc, name: string, budget: number): FormattedDoc {
  if (doc.shape !== 'workbook') throw new Error('formatWorkbook called with a prose document')

  const manifestLines = doc.sheets.map((s) => {
    const headers = (s.rows[0] ?? []).slice(0, HEADER_PREVIEW).map((h) => h.trim()).filter(Boolean)
    const more = (s.rows[0]?.length ?? 0) > HEADER_PREVIEW ? '…' : ''
    const cols = headers.length > 0 ? `: ${headers.join(', ')}${more}` : ''
    return `  ${s.name} (${s.rowCount.toLocaleString()} rows × ${s.colCount} cols)${cols}`
  })
  const manifest = `[workbook: ${name} — ${describeOfficeDoc(doc)}]\n${manifestLines.join('\n')}`

  // Serialize each sheet's rows once, so the budget is planned against the real
  // cost rather than an estimate, and the slicing below reuses the same strings.
  const serialized = doc.sheets.map((s) => s.rows.map(toCsvRow))
  const sizes = serialized.map((rows) => rows.reduce((n, r) => n + r.length + 1, 0))
  const rowBudget = Math.max(0, budget - manifest.length)
  const alloc = planSheetBudget(sizes, rowBudget)

  const blocks: string[] = []
  let truncated = false
  doc.sheets.forEach((s, i) => {
    const rows = serialized[i]
    if (rows.length === 0) return
    let spent = 0
    let shown = 0
    for (const row of rows) {
      const cost = row.length + 1
      if (spent + cost > alloc[i]) break
      spent += cost
      shown++
    }
    if (shown === 0) {
      truncated = true
      return
    }
    if (shown < rows.length) truncated = true
    const range = `rows 1–${shown} of ${s.rowCount.toLocaleString()}`
    blocks.push(`--- ${s.name} (${range}) ---\n${rows.slice(0, shown).join('\n')}`)
  })

  const note = truncated
    ? '[Note: some rows were omitted to fit the text budget; every sheet is listed above with its true dimensions.]'
    : null
  const body = blocks.length > 0 ? `\n\n${blocks.join('\n\n')}` : ''
  const tail = note ? `\n${note}` : ''
  return { text: `${manifest}${body}${tail}`, truncated, note }
}

/** Format any normalized document — the single entry point attachments.ts uses. */
export function formatOfficeDoc(doc: OfficeDoc, name: string, budget: number): FormattedDoc {
  return doc.shape === 'workbook' ? formatWorkbook(doc, name, budget) : formatProse(doc, name, budget)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/platform/officeText.test.ts`
Expected: PASS. If the multi-round redistribution figures differ, recompute by hand from the algorithm and correct the *test's* expected numbers — do not weaken the assertion to `toBeGreaterThan`.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/platform/officeText.ts src/platform/officeText.test.ts
git commit -m "feat(office): workbook manifest with fair-share row budgeting"
```

---

### Task 3: The parser shell — lazy import, LRU cache, AST mapping

**Files:**
- Create: `src/platform/office.ts`
- Test: `src/platform/office.test.ts`

**Interfaces:**
- Consumes: `OfficeDoc`, `OfficeFormat`, `officeFormatFor`, `WorkbookSheet`, `ProseSegment` from Task 1.
- Produces: `OfficeError`, `parseOfficeDocument(bytes, id, name, mimeType)`, `MAX_OFFICE_BYTES`.

- [ ] **Step 1: Write the failing test**

Create `src/platform/office.test.ts`. Fixtures are generated with `fflate` so the repo carries no binary assets:

```ts
import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { parseOfficeDocument, OfficeError } from './office'

const CONTENT_TYPES_DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

function makeDocx(): Uint8Array {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
<w:p><w:r><w:t>Revenue grew 12% in APAC.</w:t></w:r></w:p>
</w:body></w:document>`
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES_DOCX),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(doc),
  })
}

/** `rows` is a list of [ref, value] pairs so a row can deliberately skip a column. */
function makeXlsx(sheets: { name: string; rows: [string, string][][] }[]): Uint8Array {
  const cell = ([ref, v]: [string, string]) => `<c r="${ref}" t="str"><v>${v}</v></c>`
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
</Relationships>`),
  }
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
${s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map(cell).join('')}</row>`).join('\n')}
</sheetData></worksheet>`)
  })
  return zipSync(files)
}

describe('parseOfficeDocument', () => {
  it('maps a docx to prose segments', async () => {
    const doc = await parseOfficeDocument(makeDocx(), 'id-docx', 'report.docx', '')
    expect(doc.shape).toBe('prose')
    if (doc.shape !== 'prose') throw new Error('unreachable')
    expect(doc.format).toBe('docx')
    const all = doc.segments.map((s) => s.text).join('\n')
    expect(all).toContain('Quarterly Report')
    expect(all).toContain('Revenue grew 12% in APAC.')
  })

  it('maps an xlsx to named sheets', async () => {
    const bytes = makeXlsx([
      { name: 'Q1', rows: [[['A1', 'Date'], ['B1', 'Region']], [['A2', '2026-01-03'], ['B2', 'APAC']]] },
      { name: 'Notes', rows: [[['A1', 'Topic']]] },
    ])
    const doc = await parseOfficeDocument(bytes, 'id-xlsx', 'sales.xlsx', '')
    expect(doc.shape).toBe('workbook')
    if (doc.shape !== 'workbook') throw new Error('unreachable')
    expect(doc.sheets.map((s) => s.name)).toEqual(['Q1', 'Notes'])
    expect(doc.sheets[0].rows[0]).toEqual(['Date', 'Region'])
    expect(doc.sheets[0].rowCount).toBe(2)
  })

  it('rebuilds a sparse row by column index, not array position', async () => {
    // B2 is absent. Placing C2 at index 1 would silently shift every later
    // column left and misalign the whole sheet against its headers.
    const bytes = makeXlsx([
      { name: 'S', rows: [
        [['A1', 'a'], ['B1', 'b'], ['C1', 'c']],
        [['A2', 'x'], ['C2', 'z']],
      ] },
    ])
    const doc = await parseOfficeDocument(bytes, 'id-sparse', 'sparse.xlsx', '')
    if (doc.shape !== 'workbook') throw new Error('unreachable')
    expect(doc.sheets[0].rows[1]).toEqual(['x', '', 'z'])
    expect(doc.sheets[0].colCount).toBe(3)
  })

  it('rejects an unsupported file with an OfficeError', async () => {
    await expect(
      parseOfficeDocument(new Uint8Array([1, 2, 3, 4]), 'id-bad', 'broken.docx', ''),
    ).rejects.toBeInstanceOf(OfficeError)
  })

  it('rejects a file over the size cap before parsing', async () => {
    const huge = new Uint8Array(26 * 1024 * 1024)
    await expect(parseOfficeDocument(huge, 'id-huge', 'huge.docx', '')).rejects.toThrow(/25 MB/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/platform/office.test.ts`
Expected: FAIL — `Failed to resolve import "./office"`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/office.ts`:

```ts
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

function toProse(content: any[], format: Exclude<OfficeFormat, 'xlsx' | 'ods'>, imageCount: number): OfficeDoc {
  const segments: ProseSegment[] = []
  let slide = 0
  let body: string[] = []

  const flushBody = () => {
    if (body.length === 0) return
    segments.push({ label: 'Document', text: body.join('\n\n') })
    body = []
  }

  for (const node of content) {
    // pptx/odp group by slide; epub by chapter/section. Everything else is one
    // body segment, which keeps a plain docx from being chopped arbitrarily.
    if (node?.type === 'slide' || node?.type === 'section' || node?.type === 'chapter') {
      flushBody()
      slide++
      const label = node.metadata?.title
        ? String(node.metadata.title)
        : format === 'pptx' || format === 'odp'
          ? `Slide ${slide}`
          : `Section ${slide}`
      const text = (Array.isArray(node.children) ? node.children : []).map(nodeText).join('\n\n')
      segments.push({ label, text })
      continue
    }
    const text = nodeText(node)
    if (text.trim().length > 0) body.push(node?.type === 'heading' ? `# ${text}` : text)
  }
  flushBody()
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/platform/office.test.ts`
Expected: PASS.

If TypeScript cannot resolve types for `officeparser/slim`, add to `src/vite-env.d.ts` (or create `src/officeparser-slim.d.ts`):

```ts
declare module 'officeparser/slim' {
  export function parseOffice(input: Uint8Array, config?: Record<string, unknown>): Promise<any>
}
```

If the prose segment labels or slide grouping do not match the real AST (`node.type` values differ from `'slide'`/`'section'`/`'chapter'`), print `ast.content.map(n => n.type)` for a pptx fixture and adjust `toProse` to the actual node types. Do not weaken the tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/platform/office.ts src/platform/office.test.ts
git commit -m "feat(office): lazy officeParser shell with sparse-safe AST mapping"
```

---

### Task 4: Classification and delivery routing

**Files:**
- Modify: `src/agent/attachmentPlan.ts`
- Test: `src/agent/attachmentPlan.test.ts`

**Interfaces:**
- Consumes: `officeFormatFor`, `isLegacyOfficeName` from Task 1.
- Produces: `AttachmentKind` including `'document'`; `DOCUMENT_MAX_BYTES`; `DOCUMENT_TEXT_BUDGET`; `{ route: 'document-text'; budget: number }`.

- [ ] **Step 1: Write the failing test**

Append to `src/agent/attachmentPlan.test.ts`:

```ts
describe('classifyIncomingFile — office documents', () => {
  it('classifies each office format as a document', () => {
    for (const name of ['a.docx', 'a.pptx', 'a.xlsx', 'a.odt', 'a.odp', 'a.ods', 'a.rtf', 'a.epub']) {
      expect(classifyIncomingFile(name, '', 1000)).toEqual({ kind: 'document' })
    }
  })

  it('rejects an oversized document by name', () => {
    const result = classifyIncomingFile('big.docx', '', 26 * 1024 * 1024)
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toMatch(/25 MB/)
  })

  it('gives legacy binary formats their own message', () => {
    for (const name of ['old.doc', 'old.xls', 'old.ppt']) {
      const result = classifyIncomingFile(name, '', 1000)
      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toMatch(/re-save as/i)
    }
  })

  it('still routes text-like files to text, unchanged', () => {
    // Regression guard: officeParser also parses these, but they already work
    // through the inline-text path and must not be rerouted.
    expect(classifyIncomingFile('a.csv', 'text/csv', 1000)).toEqual({ kind: 'text' })
    expect(classifyIncomingFile('a.md', '', 1000)).toEqual({ kind: 'text' })
    expect(classifyIncomingFile('a.html', 'text/html', 1000)).toEqual({ kind: 'text' })
    expect(classifyIncomingFile('a.txt', 'text/plain', 1000)).toEqual({ kind: 'text' })
  })

  it('still routes PDFs to pdf, unchanged', () => {
    expect(classifyIncomingFile('a.pdf', 'application/pdf', 1000)).toEqual({ kind: 'pdf' })
  })
})

describe('planAttachmentDelivery — documents', () => {
  const ctx = { supportsNativeDocuments: true, nativeDocMaxBytes: 32 * 1024 * 1024, visionCapable: true }

  it('routes a document to budgeted text on every provider', () => {
    const doc = { kind: 'document' as const, name: 'a.docx', byteSize: 1000 }
    expect(planAttachmentDelivery(doc, ctx)).toEqual({ route: 'document-text', budget: DOCUMENT_TEXT_BUDGET })
    expect(planAttachmentDelivery(doc, { ...ctx, supportsNativeDocuments: false, visionCapable: false }))
      .toEqual({ route: 'document-text', budget: DOCUMENT_TEXT_BUDGET })
  })
})
```

Add `DOCUMENT_TEXT_BUDGET` to the file's existing import from `./attachmentPlan`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/agent/attachmentPlan.test.ts`
Expected: FAIL — office files classify as an error, `DOCUMENT_TEXT_BUDGET` undefined.

- [ ] **Step 3: Write the implementation**

In `src/agent/attachmentPlan.ts`:

Add the import at the top of the file (after the header comment):

```ts
import { officeFormatFor, isLegacyOfficeName } from '../platform/officeText'
```

Change the kind union:

```ts
/** What a dropped/picked file was classified as. */
export type AttachmentKind = 'image' | 'pdf' | 'text' | 'document'
```

Add the constants beside the existing ones:

```ts
/** Office documents are zip-compressed; 25 MB is already an enormous one. */
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024
/** Char budget for an extracted office document. */
export const DOCUMENT_TEXT_BUDGET = 48_000
```

In `classifyIncomingFile`, insert these two branches **after** the PDF branch and **before** the `text/` branch — order matters, because the text branch would otherwise claim `.rtf` via its `text/rtf` MIME:

```ts
  if (isLegacyOfficeName(name, mimeType)) {
    const modern = /\.doc$|msword/i.test(`${name} ${mimeType}`) ? '.docx'
      : /\.xls$|ms-excel/i.test(`${name} ${mimeType}`) ? '.xlsx'
      : '.pptx'
    return { error: `"${name}" is a legacy binary Office file, which can't be read here — re-save as ${modern}.` }
  }
  if (officeFormatFor(name, mimeType)) {
    return byteSize > DOCUMENT_MAX_BYTES
      ? { error: `"${name}" is larger than the 25 MB document limit.` }
      : { kind: 'document' }
  }
```

Add the route to the union:

```ts
  | { route: 'document-text'; budget: number }
```

And in `planAttachmentDelivery`, before the final `inline-text` return:

```ts
  if (att.kind === 'document') {
    // No provider takes an office file natively — the two native adapters accept
    // PDF documents only, and the compat adapter throws on any non-image file
    // part. Extracted text is the one form that works everywhere.
    return { route: 'document-text', budget: DOCUMENT_TEXT_BUDGET }
  }
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. The existing `attachmentPlan` and `attachments` tests must stay green — if a previously-passing case now fails, the new branches are placed wrongly (most likely `.rtf` or `.csv` ordering).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/agent/attachmentPlan.ts src/agent/attachmentPlan.test.ts
git commit -m "feat(office): classify and route office documents to budgeted text"
```

---

### Task 5: Composer ingestion and message assembly

**Files:**
- Modify: `src/ui/attachments.ts`
- Modify: `src/data/attachments.ts`
- Test: `src/ui/attachments.test.ts`

**Interfaces:**
- Consumes: `parseOfficeDocument`, `OfficeError` (Task 3); `formatOfficeDoc`, `describeOfficeDoc`, `OfficeDoc` (Tasks 1–2); `DOCUMENT_TEXT_BUDGET` (Task 4).
- Produces: `ComposerAttachment` variant `{ kind: 'document'; id; name; bytes; byteSize; doc; docSummary }`; `AttachmentMeta.docSummary`.

- [ ] **Step 1: Write the failing test**

Append to `src/ui/attachments.test.ts`:

```ts
describe('attachmentUiMetas — documents', () => {
  it('carries the document summary onto the chip meta', () => {
    const att = {
      kind: 'document' as const,
      id: 'd1',
      name: 'deck.pptx',
      bytes: new Uint8Array([1]),
      byteSize: 1,
      doc: { shape: 'prose' as const, format: 'pptx' as const, segments: [], imageCount: 0 },
      docSummary: '12 slides',
    }
    const [meta] = attachmentUiMetas([att])
    expect(meta.kind).toBe('document')
    expect(meta.docSummary).toBe('12 slides')
    expect(meta.byteSize).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/ui/attachments.test.ts`
Expected: FAIL — `'document'` is not assignable to the `ComposerAttachment` union.

- [ ] **Step 3: Write the implementation**

In `src/data/attachments.ts`, add one optional field to `AttachmentMeta`:

```ts
  /** Office documents only — a short summary like "12 slides" for the chip. */
  docSummary?: string
```

In `src/ui/attachments.ts`:

Add imports:

```ts
import { parseOfficeDocument, OfficeError } from '../platform/office'
import { formatOfficeDoc, describeOfficeDoc, type OfficeDoc } from '../platform/officeText'
```

Extend the `ComposerAttachment` union with a fourth variant:

```ts
  | {
      kind: 'document'
      id: string
      name: string
      bytes: Uint8Array
      byteSize: number
      /** Parsed at attach time; reused at send time. */
      doc: OfficeDoc
      docSummary: string
    }
```

Add the ingest function beside `ingestPdf`:

```ts
async function ingestDocument(file: File, id: string): Promise<ComposerAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // Parsing here doubles as validation: a corrupt, encrypted or mislabelled
  // file throws an OfficeError NOW, in the composer, rather than failing the
  // send later. The parse stays in office.ts's cache under this id, so the
  // send-time format is free.
  const doc = await parseOfficeDocument(bytes, id, file.name, file.type)
  return {
    kind: 'document',
    id,
    name: file.name,
    bytes,
    byteSize: bytes.byteLength,
    doc,
    docSummary: describeOfficeDoc(doc),
  }
}
```

In `ingestFiles`, add the branch and widen the error mapping:

```ts
      } else if (classified.kind === 'document') {
        attachments.push(await ingestDocument(file, id))
      } else {
```

```ts
    } catch (err) {
      const msg =
        err instanceof PdfError || err instanceof OfficeError
          ? err.message
          : `Could not read "${file.name}".`
      errors.push(msg)
    }
```

In `attachmentUiMetas`, add the summary:

```ts
    ...(a.kind === 'document' ? { docSummary: a.docSummary } : {}),
```

In `assembleAttachments`, add the delivery branch after the `pdf-text` branch:

```ts
      } else if (plan.route === 'document-text' && att.kind === 'document') {
        blocks.push(formatOfficeDoc(att.doc, att.name, plan.budget).text)
      } else if (plan.route === 'inline-text' && att.kind === 'text') {
```

And extend the persistence `dataUrl` expression so a document stores its original bytes:

```ts
    const dataUrl =
      att.kind === 'image'
        ? att.dataUrl
        : att.kind === 'pdf'
          ? (pdfDataUrl ?? bytesToDataUrl(att.bytes, 'application/pdf'))
          : att.kind === 'document'
            ? bytesToDataUrl(att.bytes, 'application/octet-stream')
            : bytesToDataUrl(new TextEncoder().encode(att.text), 'text/plain')
```

Finally extend the `label` helper used for the journal note:

```ts
  const label = (a: ComposerAttachment) =>
    a.kind === 'pdf' ? `${a.name} (${a.pageCount} pages)`
    : a.kind === 'document' ? `${a.name} (${a.docSummary})`
    : a.name
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/ui/attachments.ts src/ui/attachments.test.ts src/data/attachments.ts
git commit -m "feat(office): ingest and assemble office documents in the composer"
```

---

### Task 6: Composer and transcript chips

**Files:**
- Modify: `src/ui/Chat.tsx` (`FileKindIcon` near line 476; composer chips near line 3071; transcript chips near line 3635)

**Interfaces:**
- Consumes: `ComposerAttachment` document variant and `AttachmentMeta.docSummary` from Task 5.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Widen the icon component**

Change the signature and add a document glyph (a page with lines, distinct from the PDF outline):

```tsx
/** Glyph for a non-image attachment chip: a page outline (pdf), lined page (document), or code brackets (text). */
function FileKindIcon({ kind }: { kind: 'pdf' | 'text' | 'document' }) {
  if (kind === 'document') {
    return (
      <svg className="attachment-file-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M4 1.8h5.2L12.8 5v9.2a.9.9 0 0 1-.9.9H4a.9.9 0 0 1-.9-.9V2.7a.9.9 0 0 1 .9-.9Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path d="M5.6 7.4h4.8M5.6 9.6h4.8M5.6 11.8h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    )
  }
  return kind === 'pdf' ? (
```

Leave the rest of the existing body unchanged.

- [ ] **Step 2: Update the composer chip subtitle**

In the `attachment-row` block, replace the subtitle expression:

```tsx
                        <span className="attachment-file-sub">
                          {att.kind === 'pdf'
                            ? `${att.pageCount} page${att.pageCount === 1 ? '' : 's'}`
                            : att.kind === 'document'
                              ? att.docSummary
                              : formatBytes(att.byteSize)}
                        </span>
```

The `<FileKindIcon kind={att.kind} />` call above it already narrows to the three non-image kinds and needs no change.

- [ ] **Step 3: Update the transcript chip**

In the `msg-attachments` block:

```tsx
                    <FileKindIcon kind={a.kind === 'pdf' ? 'pdf' : a.kind === 'document' ? 'document' : 'text'} />
```

and the subtitle:

```tsx
                    <span className="attachment-file-sub">
                      {a.kind === 'pdf' && a.pageCount !== undefined
                        ? `${a.pageCount} page${a.pageCount === 1 ? '' : 's'}`
                        : a.kind === 'document' && a.docSummary
                          ? a.docSummary
```

Keep the existing final fallback branch of that ternary chain intact.

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed. A type error at the `FileKindIcon` call sites means a `kind` union was missed.

- [ ] **Step 5: Commit**

```bash
git add src/ui/Chat.tsx
git commit -m "feat(office): document icon and summary on attachment chips"
```

---

### Task 7: Bundle acceptance checks and end-to-end verification

**Files:**
- Modify: `docs/superpowers/specs/2026-08-08-office-document-attachments-design.md` (status line only)

**Interfaces:**
- Consumes: the built `dist/` from Task 6.
- Produces: nothing.

- [ ] **Step 1: Build clean**

```bash
rm -rf dist && npm run build
```

- [ ] **Step 2: Verify officeParser was code-split, not inlined**

```bash
grep -c "officeparser\|OfficeErrorType" dist/sidepanel.js || echo "0 — not inlined (correct)"
ls -la dist/assets/ | awk '$5 > 500000 {printf "%10d  %s\n", $5, $9}'
```

Expected: `sidepanel.js` contains **no** officeParser marker, and a separate chunk of roughly 2.7 MB exists in `dist/assets/`. If the marker appears in `sidepanel.js`, the import in `office.ts` was made static — fix it and rebuild.

- [ ] **Step 3: Verify no second pdf.js copy**

```bash
ls dist/assets/ | grep -ci "pdf.worker"
```

Expected: `1`. A `2` means officeParser's inlined pdf.js was emitted as a separate worker asset as well; record the finding and report it rather than proceeding.

- [ ] **Step 4: Exercise the panel end to end**

Use the `/verify-extension` skill: build, reload the unpacked extension at `chrome://extensions`, open the side panel, then:

1. Attach a real `.docx` — the chip shows the lined-page icon and a section count; send; the reply reflects the document's actual content.
2. Attach a real `.xlsx` with 2+ sheets — the model can name **every** sheet, including the last.
3. Attach a real `.pptx` — the chip reads "N slides".
4. Attach a `.doc` (legacy) — the composer shows the "re-save as .docx" error and no chip.
5. Attach a `.csv` alongside a `.docx` — the CSV still arrives as a fenced text block, proving the text path is unchanged.

- [ ] **Step 5: Mark the spec delivered and commit**

Update the spec's `**Status:**` line to append `· Implemented 2026-08-08`.

```bash
git add docs/superpowers/specs/2026-08-08-office-document-attachments-design.md
git commit -m "docs(spec): mark office document attachments implemented"
```

---

## Self-Review

**Spec coverage:** every spec section maps to a task — accepted types and limits → Task 4; `office.ts` shell → Task 3; `officeText.ts` → Tasks 1–2; modified-files table → Tasks 4–6; data flow → Tasks 3+5; budget policies → Tasks 1–2; error handling → Tasks 1 (empty), 3 (parse/zip), 4 (legacy/size), 5 (ingest surfacing); testing and both build acceptance checks → Task 7.

**Deferred from the spec, deliberately:** `AttachmentMeta` uses a single `docSummary` string rather than separate `segmentCount`/`sheetCount` fields — the summary is produced by the pure, tested `describeOfficeDoc`, so it stays testable while the UI avoids re-deriving per-format nouns.

**Known duplication:** `safeSlice` in `officeText.ts` is a third copy alongside `attachmentPlan.ts` and `pdfText.ts`. Consolidation is deliberately out of scope while a concurrent session owns the `pdf*` files.
