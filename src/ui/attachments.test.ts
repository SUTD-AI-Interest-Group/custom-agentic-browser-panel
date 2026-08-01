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
  // approxBytes is real (pure, no IndexedDB) — only saveAttachment is faked.
  const actual = await importOriginal<typeof import('../data/attachments')>()
  return { ...actual, saveAttachment: vi.fn().mockResolvedValue(undefined) }
})

import { assembleAttachments, attachmentUiMetas, type ComposerAttachment } from './attachments'
import { renderPdfPageFromBytes } from '../platform/pdf'
import { ensureVisionCapability } from '../agent/vision'
import { saveAttachment } from '../data/attachments'

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
