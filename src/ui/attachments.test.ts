// assembleAttachments is the impure executor of the pure delivery plan
// (agent/attachmentPlan.ts) — these tests lock down its own control flow
// (partial pdf-pages failures, persistence, byte-encoding) with pdf.js,
// vision-probing, and the attachments store mocked out.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ProviderConfig } from '../data/settings'

vi.mock('../platform/pdf', () => ({
  loadPdfFromBytes: vi.fn(),
  renderPdfPageFromBytes: vi.fn(),
  PdfError: class PdfError extends Error {},
}))
vi.mock('../agent/vision', () => ({
  ensureVisionCapability: vi.fn(),
}))
vi.mock('../data/attachments', async (importOriginal) => {
  // approxBytes is real (pure, no IndexedDB) — only saveAttachment/getAttachment are faked.
  const actual = await importOriginal<typeof import('../data/attachments')>()
  return { ...actual, saveAttachment: vi.fn().mockResolvedValue(undefined), getAttachment: vi.fn() }
})
vi.mock('../platform/office', () => ({
  parseOfficeDocument: vi.fn(),
  OfficeError: class OfficeError extends Error {},
}))

import {
  assembleAttachments,
  attachmentUiMetas,
  ingestFiles,
  makeHistoricalAttachmentResolver,
  type ComposerAttachment,
} from './attachments'
import { loadPdfFromBytes, renderPdfPageFromBytes } from '../platform/pdf'
import { ensureVisionCapability } from '../agent/vision'
import { saveAttachment, getAttachment, type StoredAttachment, type AttachmentMeta } from '../data/attachments'
import { dehydrateHistory, hydrateHistory, lycheeProviderOptions } from '../data/attachmentRefs'
import { parseOfficeDocument, OfficeError } from '../platform/office'
import type { OfficeDoc } from '../platform/officeText'
import type { PageText } from '../platform/pdfText'

// kind:'custom' -> supportsNativeDocuments:false, so a vision-capable model
// here always routes a PDF through pdf-pages (never native-pdf).
const compatProvider: ProviderConfig = {
  id: 'p1',
  name: 'Compat',
  baseURL: 'https://api.custom.example/v1',
  apiKey: 'x',
  kind: 'custom',
  models: [],
}

// kind:'anthropic' -> supportsNativeDocuments:true, so a small PDF routes native.
const nativeProvider: ProviderConfig = {
  id: 'p2',
  name: 'Anthropic',
  baseURL: 'https://api.anthropic.com',
  apiKey: 'x',
  kind: 'anthropic',
  models: [],
}

function pdfAttachment(overrides: Partial<Extract<ComposerAttachment, { kind: 'pdf' }>> = {}): ComposerAttachment {
  return {
    kind: 'pdf',
    id: 'att-1',
    name: 'doc.pdf',
    bytes: new Uint8Array([1, 2, 3]),
    byteSize: 3,
    pageCount: 5,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(saveAttachment).mockResolvedValue(undefined)
})

describe('assembleAttachments — pdf-pages route (F1)', () => {
  it('a mid-batch page-render failure keeps earlier pages captioned and still persists the attachment', async () => {
    vi.mocked(ensureVisionCapability).mockResolvedValue(true)
    vi.mocked(renderPdfPageFromBytes).mockImplementation(async (_bytes: Uint8Array, _key: string, page: number) => {
      if (page === 3) throw new Error('page 3 boom')
      return { dataUrl: `data:image/png;base64,PAGE${page}`, width: 10, height: 10, pageCount: 5, title: 'doc' }
    })
    const att = pdfAttachment({ pageCount: 5 })
    const result = await assembleAttachments([att], { provider: compatProvider, modelId: 'm', conversationId: 'c1' })

    // Pages 1-2 rendered; the loop must stop at the failing page 3, never
    // attempting 4/5, and never leaving pages 1-2 without an accurate caption.
    expect(result.parts).toHaveLength(2)
    expect(vi.mocked(renderPdfPageFromBytes)).toHaveBeenCalledTimes(3)

    // The old code's outer catch produced ONLY "could not be processed" text
    // while 2 uncaptioned image parts sat in `parts` — a direct violation of
    // the image invariant. The fix must name what actually happened instead.
    expect(result.appendText).not.toContain('could not be processed')
    expect(result.appendText).toContain('page 3')
    expect(result.appendText.toLowerCase()).toMatch(/fail|omit/)

    // The old code's `continue` skipped saveAttachment for the whole
    // attachment, permanently losing it from storage despite 2 pages having
    // just been shown to the model.
    expect(saveAttachment).toHaveBeenCalledTimes(1)
    expect(saveAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: 'att-1', conversationId: 'c1' }))
  })

  it('every page failing (including the first) still persists and reports cleanly, no dangling page-1 caption', async () => {
    vi.mocked(ensureVisionCapability).mockResolvedValue(true)
    vi.mocked(renderPdfPageFromBytes).mockRejectedValue(new Error('render engine unavailable'))
    const att = pdfAttachment({ pageCount: 3 })
    const result = await assembleAttachments([att], { provider: compatProvider, modelId: 'm', conversationId: 'c1' })

    expect(result.parts).toHaveLength(0)
    expect(result.appendText).not.toMatch(/page undefined/i)
    expect(result.appendText.toLowerCase()).toMatch(/no pages|could not/i)
    expect(saveAttachment).toHaveBeenCalledTimes(1)
  })

  it('all pages succeeding is unaffected — full caption, one persist call', async () => {
    vi.mocked(ensureVisionCapability).mockResolvedValue(true)
    vi.mocked(renderPdfPageFromBytes).mockImplementation(async (_bytes: Uint8Array, _key: string, page: number) => ({
      dataUrl: `data:image/png;base64,PAGE${page}`,
      width: 10,
      height: 10,
      pageCount: 2,
      title: 'doc',
    }))
    const att = pdfAttachment({ pageCount: 2 })
    const result = await assembleAttachments([att], { provider: compatProvider, modelId: 'm', conversationId: 'c1' })

    expect(result.parts).toHaveLength(2)
    expect(result.appendText).not.toContain('could not be processed')
    expect(result.appendText).toContain('page 1 of 2')
    expect(result.appendText).toContain('page 2 of 2')
    expect(saveAttachment).toHaveBeenCalledTimes(1)
  })

  it('a 0-page PDF (F5) renders page 1 per the planner, fails cleanly when it does not exist, and still persists', async () => {
    // planAttachmentDelivery now treats pageCount:0 like unknown -> pages:[1].
    // Rendering a page that genuinely does not exist is exactly the kind of
    // failure the F1 fix must absorb cleanly rather than indexing an empty array.
    vi.mocked(ensureVisionCapability).mockResolvedValue(true)
    vi.mocked(renderPdfPageFromBytes).mockRejectedValue(new Error('No page 1 — this PDF has 0 pages.'))
    const att = pdfAttachment({ pageCount: 0 })
    const result = await assembleAttachments([att], { provider: compatProvider, modelId: 'm', conversationId: 'c1' })

    expect(result.parts).toHaveLength(0)
    expect(result.appendText).not.toMatch(/page undefined/i)
    expect(saveAttachment).toHaveBeenCalledTimes(1)
  })
})

describe('attachmentUiMetas — image byte-size estimate (F7)', () => {
  it('does not count the data-URL header toward the reported byte size', () => {
    // Payload "AAAA" base64-decodes to exactly 3 bytes; the old code ran the
    // 4/3 conversion over the WHOLE data URL (header included), overestimating.
    const dataUrl = 'data:image/png;base64,AAAA'
    const meta = attachmentUiMetas([
      { kind: 'image', id: 'i1', name: 'a.png', dataUrl, width: 1, height: 1, thumbDataUrl: dataUrl },
    ])
    expect(meta[0].byteSize).toBe(3)
  })
})

describe('assembleAttachments — native-pdf route (F4)', () => {
  it('base64-encodes the PDF bytes once per attachment, not twice', async () => {
    vi.mocked(ensureVisionCapability).mockResolvedValue(true)
    const spy = vi.spyOn(globalThis, 'btoa')
    const att = pdfAttachment({ byteSize: 100, bytes: new Uint8Array(100).fill(7), pageCount: 3 })
    const result = await assembleAttachments([att], { provider: nativeProvider, modelId: 'm', conversationId: 'c1' })

    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].mediaType).toBe('application/pdf')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(saveAttachment).toHaveBeenCalledTimes(1)
  })
})

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

const pptxDoc: OfficeDoc = {
  shape: 'prose',
  format: 'pptx',
  segments: [
    { label: 'Slide 1', text: 'Hello' },
    { label: 'Slide 2', text: 'World' },
  ],
  imageCount: 0,
}

function documentAttachment(overrides: Partial<Extract<ComposerAttachment, { kind: 'document' }>> = {}): ComposerAttachment {
  return {
    kind: 'document',
    id: 'doc-1',
    name: 'deck.pptx',
    bytes: new Uint8Array([9, 9, 9]),
    byteSize: 3,
    doc: pptxDoc,
    docSummary: '2 slides',
    ...overrides,
  }
}

describe('assembleAttachments — document-text route', () => {
  it('appends formatted text, adds no file part, and persists the original under the real office MIME type', async () => {
    vi.mocked(ensureVisionCapability).mockResolvedValue(true)
    const att = documentAttachment()
    const result = await assembleAttachments([att], { provider: compatProvider, modelId: 'm', conversationId: 'c1' })

    // Documents are text-only in v1 — a wrong route here would either add a
    // file part (violating the image invariant: a document has no wire form
    // any adapter accepts) or silently drop the content.
    expect(result.parts).toHaveLength(0)
    expect(result.appendText).toContain('deck.pptx')
    expect(result.appendText).toContain('Slide 1')
    expect(result.appendText).toContain('Hello')
    expect(result.appendText).toContain('Slide 2')
    expect(result.appendText).toContain('World')

    // Locks in the deliberate deviation from the brief, which persisted every
    // document as 'application/octet-stream'. A generic type here would be
    // indistinguishable from any other binary blob on rehydration; the parsed
    // OfficeDoc already tells us the real format, so use it. This assertion
    // fails against the brief's literal suggestion.
    expect(saveAttachment).toHaveBeenCalledTimes(1)
    const call = vi.mocked(saveAttachment).mock.calls[0][0]
    expect(call.dataUrl).toMatch(
      /^data:application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation;base64,/,
    )
    expect(call.dataUrl).not.toContain('application/octet-stream')
    expect(call.meta.docSummary).toBe('2 slides')
  })

  it('names the document and its summary in the journal note', async () => {
    vi.mocked(ensureVisionCapability).mockResolvedValue(true)
    const att = documentAttachment({ name: 'report.docx', docSummary: '3 sections' })
    const result = await assembleAttachments([att], { provider: compatProvider, modelId: 'm', conversationId: 'c1' })
    expect(result.notes[0]).toContain('report.docx (3 sections)')
  })
})

describe('ingestFiles — office documents', () => {
  beforeEach(() => {
    vi.mocked(parseOfficeDocument).mockReset()
  })

  it('parses a dropped office file and carries the doc + summary onto the attachment', async () => {
    vi.mocked(parseOfficeDocument).mockResolvedValue(pptxDoc)
    const file = new File(['fake pptx bytes'], 'deck.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
    const result = await ingestFiles([file], 0)

    expect(result.errors).toEqual([])
    expect(result.attachments).toHaveLength(1)
    const att = result.attachments[0]
    expect(att.kind).toBe('document')
    if (att.kind !== 'document') throw new Error('expected a document attachment')
    expect(att.doc).toBe(pptxDoc)
    // describeOfficeDoc is real (not mocked) — this fails if the pluralization
    // or unit-noun logic in officeText.ts regresses, not just if ingestFiles
    // forgets to call it.
    expect(att.docSummary).toBe('2 slides')
    expect(vi.mocked(parseOfficeDocument)).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.any(String),
      'deck.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    )
  })

  it('a corrupt document reports its OfficeError message and does not abort the rest of the batch', async () => {
    vi.mocked(parseOfficeDocument).mockImplementation(async (_bytes, _id, name) => {
      if (name === 'bad.pptx') throw new OfficeError(`Could not read "bad.pptx": unexpected end of zip data`)
      return pptxDoc
    })
    const bad = new File(['x'], 'bad.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
    const good = new File(['y'], 'good.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
    const result = await ingestFiles([bad, good], 0)

    // A wrong catch (checking only `instanceof PdfError`, as the pre-Task-5
    // code did) would fall through to the generic "Could not read" message
    // instead of surfacing OfficeError's specific text — this assertion
    // distinguishes the two.
    expect(result.errors).toEqual(['Could not read "bad.pptx": unexpected end of zip data'])
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].name).toBe('good.pptx')
  })
})

// makeHistoricalAttachmentResolver is hydrateHistory's (src/data/attachmentRefs.ts)
// per-conversation resolver — the counterpart to assembleAttachments for
// ALREADY-SENT history. These tests lock down the one axis that's actually
// provider-sensitive (a whole-document native-pdf part) and confirm every
// other historical shape is left alone, including the cost guard: a PDF that
// still fits the active native provider must never probe vision capability,
// since a cache miss there is a live model round-trip, not a storage read.
describe('makeHistoricalAttachmentResolver', () => {
  const pdfMeta = (overrides: Partial<AttachmentMeta> = {}): AttachmentMeta => ({
    id: 'a1',
    kind: 'pdf',
    name: 'doc.pdf',
    byteSize: 1024,
    pageCount: 3,
    ...overrides,
  })
  const storedPdf = (overrides: Partial<StoredAttachment> = {}): StoredAttachment => ({
    id: 'a1',
    conversationId: 'c1',
    meta: pdfMeta(),
    dataUrl: 'data:application/pdf;base64,AAAA',
    createdAt: Date.now(),
    bytes: 1024,
    ...overrides,
  })

  it('degrades a native-pdf part to rendered page images when the active provider lost native-document support (F-attach-1)', async () => {
    vi.mocked(getAttachment).mockResolvedValue(storedPdf())
    vi.mocked(ensureVisionCapability).mockResolvedValue(true)
    vi.mocked(renderPdfPageFromBytes).mockImplementation(async (_bytes: Uint8Array, _key: string, page: number) => ({
      dataUrl: `data:image/png;base64,PAGE${page}`,
      width: 10,
      height: 10,
      pageCount: 3,
      title: 'doc',
    }))
    const resolve = makeHistoricalAttachmentResolver(compatProvider, 'm')
    const result = await resolve({ id: 'a1' }, 'application/pdf')

    if (!result || !('replace' in result)) throw new Error('expected a replace result')
    expect(result.replace).toHaveLength(4) // 1 caption + 3 rendered pages
    expect(result.replace[0]).toMatchObject({ type: 'text' })
    expect((result.replace[0] as { text: string }).text).toContain('doc.pdf')
    expect(result.replace[1]).toMatchObject({ type: 'file', mediaType: 'image', data: 'data:image/png;base64,PAGE1' })
    expect(result.replace[2]).toMatchObject({ type: 'file', mediaType: 'image', data: 'data:image/png;base64,PAGE2' })
    expect(result.replace[3]).toMatchObject({ type: 'file', mediaType: 'image', data: 'data:image/png;base64,PAGE3' })
    // never sends a native-pdf-shaped part to a provider that can't take one
    expect(result.replace.some((p) => p.type === 'file' && p.mediaType === 'application/pdf')).toBe(false)
  })

  it('degrades a native-pdf part to extracted text when the active provider is compatible AND blind', async () => {
    vi.mocked(getAttachment).mockResolvedValue(storedPdf())
    vi.mocked(ensureVisionCapability).mockResolvedValue(false)
    const pages: PageText[] = [
      { page: 1, text: 'Page one text' },
      { page: 2, text: 'Page two text' },
      { page: 3, text: 'Page three text' },
    ]
    vi.mocked(loadPdfFromBytes).mockResolvedValue({
      info: {
        url: '',
        title: 'doc',
        pageCount: 3,
        extractedPages: 3,
        pdfType: 'TextBased',
        pagesNeedingOcr: [],
        hasEncodingIssues: false,
      },
      pages,
    })
    const resolve = makeHistoricalAttachmentResolver(compatProvider, 'm')
    const result = await resolve({ id: 'a1' }, 'application/pdf')

    if (!result || !('replace' in result)) throw new Error('expected a replace result')
    expect(result.replace).toHaveLength(1)
    expect(result.replace[0]).toMatchObject({ type: 'text' })
    const text = (result.replace[0] as { text: string }).text
    expect(text).toContain('doc.pdf')
    expect(text).toContain('Page one text')
    expect(renderPdfPageFromBytes).not.toHaveBeenCalled()
  })

  it('a PDF that still fits the active native provider passes through unchanged — no regression, no vision probe (F-attach-2)', async () => {
    vi.mocked(getAttachment).mockResolvedValue(storedPdf())
    const resolve = makeHistoricalAttachmentResolver(nativeProvider, 'm')
    const result = await resolve({ id: 'a1' }, 'application/pdf')

    expect(result).toEqual({ data: 'data:application/pdf;base64,AAAA' })
    expect(renderPdfPageFromBytes).not.toHaveBeenCalled()
    expect(loadPdfFromBytes).not.toHaveBeenCalled()
    expect(ensureVisionCapability).not.toHaveBeenCalled()
  })

  it('a PDF too large for the active native provider\'s byte cap still degrades (native-vs-native switch, not just native-vs-compat)', async () => {
    // nativeProvider's profile (anthropic) caps native docs at 20MB; a PDF
    // that only fit a bigger cap (e.g. OpenAI's 35MB) must still degrade here,
    // not just when the axis is "native adapter at all".
    vi.mocked(getAttachment).mockResolvedValue(storedPdf({ meta: pdfMeta({ byteSize: 25 * 1024 * 1024 }) }))
    vi.mocked(ensureVisionCapability).mockResolvedValue(true)
    vi.mocked(renderPdfPageFromBytes).mockImplementation(async (_bytes: Uint8Array, _key: string, page: number) => ({
      dataUrl: `data:image/png;base64,PAGE${page}`,
      width: 10,
      height: 10,
      pageCount: 3,
      title: 'doc',
    }))
    const resolve = makeHistoricalAttachmentResolver(nativeProvider, 'm')
    const result = await resolve({ id: 'a1' }, 'application/pdf')
    if (!result || !('replace' in result)) throw new Error('expected a replace result')
    expect(result.replace.some((p) => p.type === 'file' && p.mediaType === 'application/pdf')).toBe(false)
  })

  it('an image attachment is unaffected regardless of which provider is active (F-attach-3)', async () => {
    const storedImage: StoredAttachment = {
      id: 'i1',
      conversationId: 'c1',
      meta: { id: 'i1', kind: 'image', name: 'shot.png', byteSize: 100 },
      dataUrl: 'data:image/png;base64,AAAA',
      createdAt: Date.now(),
      bytes: 100,
    }
    vi.mocked(getAttachment).mockResolvedValue(storedImage)
    for (const provider of [nativeProvider, compatProvider]) {
      const resolve = makeHistoricalAttachmentResolver(provider, 'm')
      const result = await resolve({ id: 'i1' }, 'image')
      expect(result).toEqual({ data: 'data:image/png;base64,AAAA' })
    }
    // an ordinary image part never touches the pdf ladder at all
    expect(ensureVisionCapability).not.toHaveBeenCalled()
    expect(loadPdfFromBytes).not.toHaveBeenCalled()
  })

  it('an already-rendered PDF page (a `page` ref) is re-rendered unchanged, never replanned', async () => {
    vi.mocked(getAttachment).mockResolvedValue(storedPdf())
    vi.mocked(renderPdfPageFromBytes).mockResolvedValue({
      dataUrl: 'data:image/png;base64,REPAGE',
      width: 10,
      height: 10,
      pageCount: 3,
      title: 'doc',
    })
    const resolve = makeHistoricalAttachmentResolver(compatProvider, 'm')
    const result = await resolve({ id: 'a1', page: 2 }, 'image')
    expect(result).toEqual({ data: 'data:image/png;base64,REPAGE' })
    expect(ensureVisionCapability).not.toHaveBeenCalled()
  })

  it('a pruned attachment still resolves to null — hydrateHistory turns that into the explanatory text part (F-attach-4)', async () => {
    vi.mocked(getAttachment).mockResolvedValue(null)
    const resolve = makeHistoricalAttachmentResolver(compatProvider, 'm')
    const result = await resolve({ id: 'gone' }, 'application/pdf')
    expect(result).toBeNull()
  })

  it('every page failing to render still yields a clean explanatory caption, not a dangling empty page list', async () => {
    vi.mocked(getAttachment).mockResolvedValue(storedPdf())
    vi.mocked(ensureVisionCapability).mockResolvedValue(true)
    vi.mocked(renderPdfPageFromBytes).mockRejectedValue(new Error('render engine unavailable'))
    const resolve = makeHistoricalAttachmentResolver(compatProvider, 'm')
    const result = await resolve({ id: 'a1' }, 'application/pdf')
    if (!result || !('replace' in result)) throw new Error('expected a replace result')
    expect(result.replace).toHaveLength(1)
    expect(result.replace[0]).toMatchObject({ type: 'text' })
    expect((result.replace[0] as { text: string }).text.toLowerCase()).toContain('no pages')
  })

  it('a text-extraction failure (outside the per-page loop) also degrades to an explanatory text part rather than throwing', async () => {
    vi.mocked(getAttachment).mockResolvedValue(storedPdf())
    vi.mocked(ensureVisionCapability).mockResolvedValue(false)
    vi.mocked(loadPdfFromBytes).mockRejectedValue(new Error('parse failed'))
    const resolve = makeHistoricalAttachmentResolver(compatProvider, 'm')
    const result = await resolve({ id: 'a1' }, 'application/pdf')
    if (!result || !('replace' in result)) throw new Error('expected a replace result')
    expect(result.replace).toHaveLength(1)
    expect(result.replace[0]).toMatchObject({ type: 'text' })
    expect((result.replace[0] as { text: string }).text).toContain('could not be converted')
  })
})

// The headline bug: NOT a reload, but a model-picker switch mid-conversation.
// historyRef.current in Chat.tsx never re-serializes through the sentinel form
// on its own — it holds real inline data (a hydrated ModelMessage[]) for the
// conversation's whole lifetime. dehydrateHistory(history) then
// hydrateHistory(..., makeHistoricalAttachmentResolver(newProvider, newModelId))
// is the exact composition runTurnChain now runs at the top of every turn
// (send/regenerate/continue/resume — the one chokepoint every turn-start
// funnels through) specifically to catch this case. It's fully testable here,
// with no Chat.tsx-level seam needed, because both halves are pure functions
// over an ordinary ModelMessage[] plus this module's own resolver.
describe('live provider switch mid-conversation, no reload (dehydrateHistory + hydrateHistory + makeHistoricalAttachmentResolver)', () => {
  it('a native-pdf part attached under one provider degrades the next time history is prepared for a different one', async () => {
    // The exact in-memory shape historyRef.current holds right after an attach
    // + send under the FIRST (native-document) provider: real inline base64
    // data, never a sentinel — sentinels only exist in the persisted form.
    const nativePart = {
      type: 'file' as const,
      mediaType: 'application/pdf',
      filename: 'doc.pdf',
      data: 'data:application/pdf;base64,AAAA',
      providerOptions: lycheeProviderOptions({ id: 'a1' }),
    }
    const liveHistory = [
      { role: 'user' as const, content: [nativePart, { type: 'text' as const, text: 'summarize this' }] },
    ]

    vi.mocked(getAttachment).mockResolvedValue({
      id: 'a1',
      conversationId: 'c1',
      meta: { id: 'a1', kind: 'pdf', name: 'doc.pdf', byteSize: 1024, pageCount: 2 },
      dataUrl: 'data:application/pdf;base64,AAAA',
      createdAt: Date.now(),
      bytes: 1024,
    })
    vi.mocked(ensureVisionCapability).mockResolvedValue(true)
    vi.mocked(renderPdfPageFromBytes).mockImplementation(async (_bytes: Uint8Array, _key: string, page: number) => ({
      dataUrl: `data:image/png;base64,PAGE${page}`,
      width: 10,
      height: 10,
      pageCount: 2,
      title: 'doc',
    }))

    // The user switches the model picker to a compatible provider WITHOUT
    // reloading the conversation, then sends — this is what runTurnChain does
    // to historyRef.current right before that send reaches the model.
    const replanned = await hydrateHistory(
      dehydrateHistory(liveHistory),
      makeHistoricalAttachmentResolver(compatProvider, 'm'),
    )

    const parts = replanned[0].content as { type: string; mediaType?: string; text?: string }[]
    // Never sends the raw native-pdf part to a provider that can't take one —
    // this is the exact request shape that used to break every subsequent send.
    expect(parts.some((p) => p.type === 'file' && p.mediaType === 'application/pdf')).toBe(false)
    expect(parts.some((p) => p.type === 'file' && p.mediaType === 'image')).toBe(true)
    // The message's own text survives the splice untouched.
    expect(parts.some((p) => p.type === 'text' && p.text === 'summarize this')).toBe(true)
  })

  it('a native-pdf part is left alone when re-prepared for the SAME (still-native) provider — no reload, no drift', async () => {
    const nativePart = {
      type: 'file' as const,
      mediaType: 'application/pdf',
      filename: 'doc.pdf',
      data: 'data:application/pdf;base64,AAAA',
      providerOptions: lycheeProviderOptions({ id: 'a1' }),
    }
    const liveHistory = [{ role: 'user' as const, content: [nativePart] }]
    vi.mocked(getAttachment).mockResolvedValue({
      id: 'a1',
      conversationId: 'c1',
      meta: { id: 'a1', kind: 'pdf', name: 'doc.pdf', byteSize: 1024, pageCount: 2 },
      dataUrl: 'data:application/pdf;base64,AAAA',
      createdAt: Date.now(),
      bytes: 1024,
    })

    const replanned = await hydrateHistory(
      dehydrateHistory(liveHistory),
      makeHistoricalAttachmentResolver(nativeProvider, 'm'),
    )
    const parts = replanned[0].content as { type: string; mediaType?: string; data?: string }[]
    expect(parts).toEqual([expect.objectContaining({ type: 'file', mediaType: 'application/pdf' })])
    expect(ensureVisionCapability).not.toHaveBeenCalled()
  })
})
