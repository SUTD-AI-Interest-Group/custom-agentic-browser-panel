import { describe, it, expect } from 'vitest'
import {
  officeFormatFor,
  isLegacyOfficeName,
  formatProse,
  describeOfficeDoc,
  type OfficeDoc,
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
    const out = formatProse(prose([{ label: 'A', text: '😀'.repeat(10) }]), 'd.docx', 15)
    expect(out.text).not.toMatch(/[\uD800-\uDBFF]$/)
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
