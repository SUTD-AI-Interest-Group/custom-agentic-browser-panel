import { describe, it, expect } from 'vitest'
import {
  officeFormatFor,
  isLegacyOfficeName,
  formatProse,
  describeOfficeDoc,
  planSheetBudget,
  toCsvRow,
  formatWorkbook,
  formatOfficeDoc,
  type OfficeDoc,
  type WorkbookSheet,
} from './officeText'

// Narrowed to the 'prose' branch (not the OfficeDoc union) so `{ ...prose(...), format: 'epub' }`
// below type-checks: spreading a union-typed value produces a union of spreads, and TS can't
// tell the 'workbook' branch's spread (missing `segments`) is unreachable here.
const prose = (segments: { label: string; text: string }[], imageCount = 0): Extract<OfficeDoc, { shape: 'prose' }> => ({
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
    // A (40 chars) fits fully in the 50-char budget; B is the segment that
    // crosses the budget and gets truncated; only C is fully "later" and omitted.
    expect(out.note).toMatch(/1 later section/)
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
    // format defaults to 'docx' in the prose() helper, which nouns as 'section' — override to
    // 'pptx' so this case actually exercises the 'slide' noun the "Slide 1" label implies.
    expect(describeOfficeDoc({ ...prose([{ label: 'Slide 1', text: 'a' }]), format: 'pptx' })).toBe('1 slide')
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
