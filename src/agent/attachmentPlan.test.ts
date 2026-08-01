import { describe, expect, it } from 'vitest'
import {
  classifyIncomingFile,
  formatInlineTextBlock,
  looksBinary,
  pageCaption,
  planAttachmentDelivery,
  IMAGE_MAX_BYTES,
  PAGE_BUDGET,
  PDF_MAX_BYTES,
  PDF_TEXT_BUDGET,
  TEXT_FILE_MAX_BYTES,
} from './attachmentPlan'

const native = { supportsNativeDocuments: true, nativeDocMaxBytes: 20 * 1024 * 1024, visionCapable: true }
const compatVision = { supportsNativeDocuments: false, nativeDocMaxBytes: 0, visionCapable: true }
const compatBlind = { supportsNativeDocuments: false, nativeDocMaxBytes: 0, visionCapable: false }
const pdf = (bytes: number, pages: number) => ({ kind: 'pdf' as const, name: 'r.pdf', byteSize: bytes, pageCount: pages })

describe('classifyIncomingFile', () => {
  it('classifies by MIME first, extension as fallback', () => {
    expect(classifyIncomingFile('a.png', 'image/png', 10)).toEqual({ kind: 'image' })
    expect(classifyIncomingFile('a.pdf', 'application/pdf', 10)).toEqual({ kind: 'pdf' })
    // browsers hand over dotfile/odd-extension text files with an empty type
    expect(classifyIncomingFile('notes.md', '', 10)).toEqual({ kind: 'text' })
    expect(classifyIncomingFile('data.csv', 'text/csv', 10)).toEqual({ kind: 'text' })
    expect(classifyIncomingFile('script.py', 'application/octet-stream', 10)).toEqual({ kind: 'text' })
  })

  it('rejects unsupported types with the filename in the error', () => {
    const r = classifyIncomingFile('deck.pptx', 'application/vnd.ms-powerpoint', 10)
    expect('error' in r && r.error).toContain('deck.pptx')
  })

  it('rejects oversize per kind', () => {
    expect('error' in classifyIncomingFile('a.png', 'image/png', IMAGE_MAX_BYTES + 1)).toBe(true)
    expect('error' in classifyIncomingFile('a.pdf', 'application/pdf', PDF_MAX_BYTES + 1)).toBe(true)
    expect('error' in classifyIncomingFile('a.txt', 'text/plain', TEXT_FILE_MAX_BYTES + 1)).toBe(true)
    expect(classifyIncomingFile('a.png', 'image/png', IMAGE_MAX_BYTES)).toEqual({ kind: 'image' })
  })
})

describe('looksBinary', () => {
  it('flags NUL/control-heavy samples, passes prose and code', () => {
    expect(looksBinary('hello\nworld\t{}')).toBe(false)
    expect(looksBinary('const x = 1\n\nif (x) {\n  y()\n}\n')).toBe(false)
    expect(looksBinary('PK\u0003\u0004\u0000\u0000')).toBe(true)
    expect(looksBinary('abc\u0000def')).toBe(true)
    expect(looksBinary('')).toBe(false)
  })
})

describe('planAttachmentDelivery', () => {
  it('routes images by vision', () => {
    const img = { kind: 'image' as const, name: 'shot.png', byteSize: 1000 }
    expect(planAttachmentDelivery(img, native)).toEqual({ route: 'image-part' })
    expect(planAttachmentDelivery(img, compatVision)).toEqual({ route: 'image-part' })
    const blind = planAttachmentDelivery(img, compatBlind)
    expect(blind.route).toBe('image-note')
    if (blind.route === 'image-note') expect(blind.note).toContain('shot.png')
  })

  it('routes small PDFs natively on native-doc providers', () => {
    expect(planAttachmentDelivery(pdf(1024, 5), native)).toEqual({ route: 'native-pdf' })
  })

  it('oversized PDF on a native provider degrades to the fallback ladder', () => {
    expect(planAttachmentDelivery(pdf(21 * 1024 * 1024, 5), native).route).toBe('pdf-pages')
    expect(planAttachmentDelivery(pdf(21 * 1024 * 1024, 5), { ...native, visionCapable: false })).toEqual({
      route: 'pdf-text',
      budget: PDF_TEXT_BUDGET,
    })
  })

  it('renders page screenshots on vision-capable non-native providers, budgeted', () => {
    expect(planAttachmentDelivery(pdf(1024, 5), compatVision)).toEqual({
      route: 'pdf-pages',
      pages: [1, 2, 3, 4, 5],
      truncationNote: null,
    })
    const long = planAttachmentDelivery(pdf(1024, 60), compatVision)
    if (long.route !== 'pdf-pages') throw new Error(long.route)
    expect(long.pages).toHaveLength(PAGE_BUDGET)
    expect(long.pages[0]).toBe(1)
    expect(long.pages[PAGE_BUDGET - 1]).toBe(PAGE_BUDGET)
    expect(long.truncationNote).toContain(`first ${PAGE_BUDGET} of 60 pages`)
  })

  it('falls back to text extraction for blind models', () => {
    expect(planAttachmentDelivery(pdf(1024, 5), compatBlind)).toEqual({ route: 'pdf-text', budget: PDF_TEXT_BUDGET })
  })

  it('text files inline everywhere', () => {
    const t = { kind: 'text' as const, name: 'notes.md', byteSize: 100 }
    expect(planAttachmentDelivery(t, native).route).toBe('inline-text')
    expect(planAttachmentDelivery(t, compatBlind).route).toBe('inline-text')
  })
})

describe('formatInlineTextBlock', () => {
  it('wraps content in a named fence', () => {
    const b = formatInlineTextBlock('notes.md', 'hello', 100)
    expect(b).toContain('--- attached file: notes.md ---')
    expect(b).toContain('hello')
    expect(b).toContain('--- end of notes.md ---')
    expect(b).not.toContain('truncated')
  })

  it('truncates over budget with a notice', () => {
    const b = formatInlineTextBlock('big.txt', 'x'.repeat(200), 100)
    expect(b).toContain('[truncated — file continues')
    expect(b.length).toBeLessThan(400)
  })
})

describe('pageCaption', () => {
  it('names the file and page', () => {
    expect(pageCaption('r.pdf', 3, 42)).toBe('r.pdf — page 3 of 42')
  })
})
