import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ extract: vi.fn(), destroy: vi.fn(), outline: vi.fn() }))
vi.mock('./pdfEngine', () => ({ getPdfEngine: () => ({ extract: mocks.extract }) }))
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {}, VerbosityLevel: { ERRORS: 0 },
  getDocument: () => ({ destroy: mocks.destroy, promise: Promise.resolve({ getOutline: mocks.outline, getMetadata: async () => ({ info: {} }) }) }),
}))
import { loadPdfMeta } from './pdf'
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  mocks.extract.mockResolvedValue({ pdfType: 'TextBased', markdown: 'Hello', pageCount: 1, title: 'Fixture', pagesNeedingOcr: [], hasEncodingIssues: false })
  mocks.destroy.mockResolvedValue(undefined); mocks.outline.mockResolvedValue([])
  vi.stubGlobal('fetch', vi.fn(async () => new Response('%PDF-1.0 fixture', { headers: { 'content-type': 'application/pdf' } })))
})
afterEach(async () => { await vi.advanceTimersByTimeAsync(30_000); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('destroys cached rendering workers after inactivity and reloads on demand', async () => {
  const url = 'https://example.com/idle.pdf'
  await loadPdfMeta(url)
  await loadPdfMeta(url)
  expect(mocks.extract).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(mocks.destroy).toHaveBeenCalledTimes(1)
  await loadPdfMeta(url)
  expect(mocks.extract).toHaveBeenCalledTimes(2)
})
it('never destroys a rendering document while a caller is using it', async () => {
  let release!: (value: any[]) => void
  mocks.outline.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const reading = loadPdfMeta('https://example.com/busy.pdf')
  await vi.waitFor(() => expect(mocks.outline).toHaveBeenCalled())
  await vi.advanceTimersByTimeAsync(31_000)
  expect(mocks.destroy).not.toHaveBeenCalled()
  release([]); await reading
  await vi.advanceTimersByTimeAsync(30_000)
  expect(mocks.destroy).toHaveBeenCalledTimes(1)
})
