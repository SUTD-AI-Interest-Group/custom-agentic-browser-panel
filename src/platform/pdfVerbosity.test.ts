// pdf.js logs at VerbosityLevel.WARNINGS by default, and its TrueType font
// sanitizer warns per malformed hinting program ("TT: undefined function: 21").
// Those are advisory — pdf.js drops the hints and renders the page fine — but
// every console.warn from an extension page is collected by chrome://extensions'
// error console, so a routine PDF turns into a wall of extension Warnings.
//
// Nothing FUNCTIONAL breaks if the verbosity argument is dropped again, which is
// exactly why it needs a test: the only symptom is console noise no other test
// would ever see. This locks the argument at the one seam that carries it.
//
// pdf.ts itself cannot be render-tested here (see pdf.test.ts — jsdom has no
// canvas binding), so both engines are mocked and the assertion is made on the
// getDocument spy; the render is expected to fail afterwards.
import { describe, it, expect, vi } from 'vitest'

const getDocument = vi.fn(() => ({
  promise: Promise.resolve({ numPages: 1 }),
  destroy: () => Promise.resolve(),
}))

vi.mock('pdfjs-dist', () => ({
  getDocument,
  GlobalWorkerOptions: {} as { workerSrc?: string },
  VerbosityLevel: { ERRORS: 0, WARNINGS: 1, INFOS: 5 },
}))

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.mjs' }))

// The text engine is a real Worker + 4.8 MB WASM; the render path only needs the
// cache entry it produces.
vi.mock('./pdfEngine', () => ({
  getPdfEngine: () => ({
    extract: async () => ({
      pdfType: 'text',
      markdown: 'hello',
      pageCount: 1,
      title: 'Fixture',
      pagesNeedingOcr: [],
      hasEncodingIssues: false,
    }),
  }),
}))

const { renderPdfPageFromBytes } = await import('./pdf')

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n')

describe('pdf.js verbosity', () => {
  it('asks pdf.js for errors only, so benign font warnings stay out of the extension error console', async () => {
    // The render itself cannot complete without a canvas — the getDocument call
    // it makes on the way there is what this asserts on.
    await renderPdfPageFromBytes(PDF_BYTES, 'verbosity-fixture', 1).catch(() => {})

    expect(getDocument).toHaveBeenCalledTimes(1)
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ verbosity: 0 }))
  })
})
