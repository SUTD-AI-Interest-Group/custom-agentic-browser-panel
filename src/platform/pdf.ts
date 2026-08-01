/// <reference types="vite/client" />
// PDF fetch/parse/render core, built on pdf.js (pdfjs-dist). Chrome's PDF
// viewer is a plugin with no scriptable DOM, so a PDF tab cannot be read the
// way ordinary pages are (tabs.ts) — instead the bytes are fetched directly
// (host_permissions <all_urls> exempts the fetch from CORS) and parsed here.
//
// Context matters: pdf.js needs a page-like environment (DOM, workers), so this
// module runs where its consumers already live — the side panel (ReadPdf tool)
// and the offscreen document (research's FetchUrl). The MV3 service worker
// never imports it. The heavy library is imported dynamically so it stays out
// of both entry bundles until a PDF is actually read; the worker script rides
// along as a Vite-emitted asset (same-origin, so the default extension CSP
// allows it).
//
// The pure logic (URL/byte detection, range parsing, search, budgeting) lives
// in pdfText.ts — keep it that way so it stays unit-testable.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import { sniffPdf, flattenOutline, type PageText, type OutlineEntry, type OutlineNode } from './pdfText'
import { findTextInChunks } from './highlightText'

/** An expected, explainable failure — the message is a sentence the model (and user) can act on. */
export class PdfError extends Error {}

export interface PdfInfo {
  /** Final URL after redirects. */
  url: string
  /** Document title (metadata), else the URL's filename. */
  title: string
  author: string
  pageCount: number
  /** Pages whose text was actually extracted (≤ pageCount — huge docs are capped). */
  extractedPages: number
}

export interface LoadedPdf {
  info: PdfInfo
  /** Extracted text, one entry per page, 1-based, in order. */
  pages: PageText[]
  /** Flattened bookmark outline with resolved 1-based page numbers (empty when the PDF has none). */
  outline: OutlineEntry[]
}

const MAX_PDF_BYTES = 50 * 1024 * 1024
const MAX_EXTRACT_PAGES = 500
const FETCH_TIMEOUT_MS = 30_000
// A parsed PDF is expensive (fetch + parse + full text walk), and a Q&A session
// hammers the same document repeatedly — so keep a few parsed docs alive. Small,
// because each holds its pdf.js doc handle (worker memory) for page rendering.
const CACHE_MAX = 3

interface CacheEntry {
  /** The loading task owns the worker resources — destroy() lives here, not on the doc proxy. */
  task: PDFDocumentLoadingTask
  doc: PDFDocumentProxy
  loaded: LoadedPdf
}

// Keyed by credentials mode + URL; holds the in-flight promise so concurrent
// calls for the same document share one load. Map insertion order is the LRU.
const cache = new Map<string, Promise<CacheEntry>>()

async function getPdfjs() {
  const pdfjs = await import('pdfjs-dist')
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  return pdfjs
}

async function fetchPdfBytes(
  url: string,
  credentials: RequestCredentials,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; finalUrl: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new PdfError(`"${url}" is not a valid URL.`)
  }
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
    throw new PdfError(`Cannot read a PDF from a ${parsed.protocol} URL.`)
  }
  let res: Response
  try {
    res = await fetch(url, {
      credentials,
      redirect: 'follow',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
        : AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    if (parsed.protocol === 'file:') {
      throw new PdfError(
        'Could not read this local PDF. The extension needs "Allow access to file URLs" enabled on its card in chrome://extensions.',
      )
    }
    throw new PdfError(
      `Could not fetch the PDF (${err instanceof Error ? err.message : String(err)}).`,
    )
  }
  if (!res.ok && res.status !== 0) {
    throw new PdfError(`Could not fetch the PDF (HTTP ${res.status}).`)
  }
  // Stream with a hard cap so a huge (or hostile) file cannot exhaust memory.
  const chunks: Uint8Array[] = []
  let total = 0
  if (res.body) {
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        total += value.byteLength
        if (total > MAX_PDF_BYTES) {
          throw new PdfError('This PDF is larger than the 50 MB limit.')
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }
  } else {
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > MAX_PDF_BYTES) throw new PdfError('This PDF is larger than the 50 MB limit.')
    chunks.push(buf)
    total = buf.byteLength
  }
  const bytes = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    bytes.set(c, off)
    off += c.byteLength
  }
  if (!sniffPdf(bytes)) {
    throw new PdfError('This URL did not return a PDF (no %PDF header found).')
  }
  return { bytes, finalUrl: res.url || url }
}

/** Resolve a pdf.js outline destination to a 1-based page number, or undefined. */
async function destToPage(doc: PDFDocumentProxy, dest: unknown): Promise<number | undefined> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest
    if (!Array.isArray(explicit) || explicit.length === 0) return undefined
    return (await doc.getPageIndex(explicit[0])) + 1
  } catch {
    return undefined
  }
}

// pdf.js outline items: { title, dest, items } (recursive). Resolve each dest
// to a page, bounding the total walked so a pathological tree stays cheap.
async function resolveOutline(doc: PDFDocumentProxy): Promise<OutlineEntry[]> {
  interface RawItem { title: string; dest: unknown; items?: RawItem[] }
  let raw: RawItem[] | null = null
  try {
    raw = (await doc.getOutline()) as RawItem[] | null
  } catch {
    return []
  }
  if (!raw?.length) return []
  let visited = 0
  const toNodes = async (items: RawItem[]): Promise<OutlineNode[]> => {
    const nodes: OutlineNode[] = []
    for (const item of items) {
      if (++visited > 200) break
      nodes.push({
        title: item.title ?? '',
        page: await destToPage(doc, item.dest),
        items: item.items?.length ? await toNodes(item.items) : undefined,
      })
    }
    return nodes
  }
  return flattenOutline(await toNodes(raw))
}

function filenameOf(url: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    return name || url
  } catch {
    return url
  }
}

async function doLoad(url: string, credentials: RequestCredentials, signal?: AbortSignal): Promise<CacheEntry> {
  const { bytes, finalUrl } = await fetchPdfBytes(url, credentials, signal)
  return parsePdfBytes(bytes, finalUrl, filenameOf(finalUrl))
}

// Parse + extract, source-agnostic: doLoad hands over fetched bytes, the
// attachment path (getBytesEntry) hands over a dropped file's bytes.
async function parsePdfBytes(
  bytes: Uint8Array,
  sourceUrl: string,
  titleFallback: string,
): Promise<CacheEntry> {
  const pdfjs = await getPdfjs()
  const task = pdfjs.getDocument({ data: bytes })
  let doc: PDFDocumentProxy
  try {
    doc = await task.promise
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'PasswordException') {
      throw new PdfError('This PDF is password-protected and cannot be read.')
    }
    throw new PdfError(
      `Could not parse this PDF (${err instanceof Error ? err.message : String(err)}).`,
    )
  }
  try {
    const meta = await doc.getMetadata().catch(() => null)
    const metaInfo = (meta?.info ?? {}) as Record<string, unknown>
    const extractCount = Math.min(doc.numPages, MAX_EXTRACT_PAGES)
    const pages: PageText[] = []
    for (let n = 1; n <= extractCount; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      // Items carry no reliable inter-run spacing; joining with a space
      // over-separates occasionally but never merges words, and every consumer
      // (search, display) normalizes whitespace anyway.
      const text = content.items
        .map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : ''))
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .trim()
      pages.push({ page: n, text })
    }
    const loaded: LoadedPdf = {
      info: {
        url: sourceUrl,
        title: (typeof metaInfo.Title === 'string' && metaInfo.Title.trim()) || titleFallback,
        author: typeof metaInfo.Author === 'string' ? metaInfo.Author : '',
        pageCount: doc.numPages,
        extractedPages: extractCount,
      },
      pages,
      outline: await resolveOutline(doc),
    }
    return { task, doc, loaded }
  } catch (err) {
    // Extraction failed after a successful parse — release the worker memory.
    task.destroy().catch(() => {})
    throw err
  }
}

async function getEntry(
  url: string,
  opts?: { credentials?: RequestCredentials; signal?: AbortSignal },
): Promise<CacheEntry> {
  const credentials = opts?.credentials ?? 'omit'
  const key = `${credentials}:${url}`
  const hit = cache.get(key)
  if (hit) {
    // Refresh recency (Map order is the LRU order).
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const pending = doLoad(url, credentials, opts?.signal)
  cache.set(key, pending)
  pending.catch(() => cache.delete(key))
  for (const [k, v] of cache) {
    if (cache.size <= CACHE_MAX) break
    cache.delete(k)
    v.then((e) => e.task.destroy().catch(() => {})).catch(() => {})
  }
  return pending
}

/**
 * Fetch and parse a PDF, returning its metadata, per-page text, and outline.
 * Cached (a few docs, LRU), so repeated search/read/view calls on the same
 * document cost one fetch+parse. Throws PdfError with an actionable sentence
 * on every expected failure (not a PDF, password, oversize, file-access…).
 */
export async function loadPdf(
  url: string,
  opts?: { credentials?: RequestCredentials; signal?: AbortSignal },
): Promise<LoadedPdf> {
  return (await getEntry(url, opts)).loaded
}

/**
 * Byte-source variant of getEntry, for PDFs that have no URL (a user-dropped
 * file). Cached under `bytes:<key>` in the same LRU, so the 20 sequential page
 * renders of one attached document parse it once. `key` is the attachment id.
 */
async function getBytesEntry(bytes: Uint8Array, key: string, titleFallback?: string): Promise<CacheEntry> {
  const cacheKey = `bytes:${key}`
  const hit = cache.get(cacheKey)
  if (hit) {
    // Refresh recency (Map order is the LRU order).
    cache.delete(cacheKey)
    cache.set(cacheKey, hit)
    return hit
  }
  if (bytes.byteLength > MAX_PDF_BYTES) throw new PdfError('This PDF is larger than the 50 MB limit.')
  if (!sniffPdf(bytes)) throw new PdfError('This file is not a PDF (no %PDF header found).')
  // pdf.js TRANSFERS the buffer it is handed to its worker, detaching the
  // caller's Uint8Array — without this copy the attachment's bytes silently
  // become zero-length after the attach-time parse and persist as an empty
  // record. The URL path (doLoad) needs no copy: its fetched bytes are
  // single-use. Keep this slice.
  const pending = parsePdfBytes(bytes.slice(), `attachment:${key}`, titleFallback ?? key)
  cache.set(cacheKey, pending)
  pending.catch(() => cache.delete(cacheKey))
  for (const [k, v] of cache) {
    if (cache.size <= CACHE_MAX) break
    cache.delete(k)
    v.then((e) => e.task.destroy().catch(() => {})).catch(() => {})
  }
  return pending
}

/** loadPdf for raw bytes (a dropped file). Same caching, errors, and shape. */
export async function loadPdfFromBytes(
  bytes: Uint8Array,
  key: string,
  titleFallback?: string,
): Promise<LoadedPdf> {
  return (await getBytesEntry(bytes, key, titleFallback)).loaded
}

// Long edge of a rendered page in device pixels — legible for the model without
// burning tokens; matches the screenshot pipeline's ballpark.
const RENDER_LONG_EDGE = 1400

// Shared canvas render for renderPdfPage / renderPdfPageHighlighted: one page,
// scaled so its long edge is RENDER_LONG_EDGE device pixels.
async function renderPageToCanvas(doc: PDFDocumentProxy, pageNumber: number) {
  const page = await doc.getPage(pageNumber)
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(3, Math.max(0.3, RENDER_LONG_EDGE / Math.max(base.width, base.height)))
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new PdfError('Could not create a canvas to render the page.')
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
  return { page, canvas, ctx, viewport }
}

/**
 * Render one page (1-based) to a PNG data URL. Shares loadPdf's document cache.
 * Runs only where a DOM canvas exists (side panel) — the research path never
 * renders.
 */
export async function renderPdfPage(
  url: string,
  pageNumber: number,
  opts?: { credentials?: RequestCredentials; signal?: AbortSignal },
): Promise<{ dataUrl: string; width: number; height: number; pageCount: number; title: string }> {
  const { doc, loaded } = await getEntry(url, opts)
  if (pageNumber < 1 || pageNumber > doc.numPages) {
    throw new PdfError(`No page ${pageNumber} — this PDF has ${doc.numPages} pages.`)
  }
  const { canvas } = await renderPageToCanvas(doc, pageNumber)
  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
    pageCount: doc.numPages,
    title: loaded.info.title,
  }
}

/** renderPdfPage for raw bytes (a dropped file). Shares the bytes: cache entry. */
export async function renderPdfPageFromBytes(
  bytes: Uint8Array,
  key: string,
  pageNumber: number,
): Promise<{ dataUrl: string; width: number; height: number; pageCount: number; title: string }> {
  const { doc, loaded } = await getBytesEntry(bytes, key)
  if (pageNumber < 1 || pageNumber > doc.numPages) {
    throw new PdfError(`No page ${pageNumber} — this PDF has ${doc.numPages} pages.`)
  }
  const { canvas } = await renderPageToCanvas(doc, pageNumber)
  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
    pageCount: doc.numPages,
    title: loaded.info.title,
  }
}

/** The subset of a pdf.js text item the highlighter needs (TextMarkedContent has no `str`). */
interface PdfTextItem {
  str: string
  transform: number[]
  width: number
  height: number
}

/**
 * Render one page with `query` marked like a highlighter pen. The match runs
 * over the page's text items (findTextInChunks — the same matcher the webpage
 * path uses, so PDF items that omit inter-word spaces still match); each
 * matched item's box is mapped through the viewport transform and painted as a
 * translucent multiply rect, so the text stays legible under the marker.
 * `matched:false` means the passage wasn't found on THIS page — the plain
 * render is returned so the caller can still show the page.
 */
export async function renderPdfPageHighlighted(
  url: string,
  pageNumber: number,
  query: string,
  opts?: { credentials?: RequestCredentials; signal?: AbortSignal },
): Promise<{
  dataUrl: string
  width: number
  height: number
  pageCount: number
  title: string
  matched: boolean
  matchCount: number
}> {
  const { doc, loaded } = await getEntry(url, opts)
  if (pageNumber < 1 || pageNumber > doc.numPages) {
    throw new PdfError(`No page ${pageNumber} — this PDF has ${doc.numPages} pages.`)
  }
  const { page, canvas, ctx, viewport } = await renderPageToCanvas(doc, pageNumber)
  const content = await page.getTextContent()
  const items = (content.items as unknown[]).filter(
    (it): it is PdfTextItem => typeof (it as PdfTextItem).str === 'string',
  )
  const m = findTextInChunks(items.map((it) => it.str), query)
  if (m.first) {
    const pdfjs = await getPdfjs()
    ctx.globalCompositeOperation = 'multiply'
    ctx.fillStyle = 'rgba(255,213,79,0.6)'
    for (let i = m.first.startChunk; i <= m.first.endChunk; i++) {
      const it = items[i]
      // Item transform is in PDF space; composing with the viewport transform
      // yields the device-space baseline origin. Glyph height falls out of the
      // composed matrix's scale component.
      const tx = pdfjs.Util.transform(viewport.transform, it.transform)
      const h = Math.hypot(tx[2], tx[3]) || it.height * viewport.scale
      const w = it.width * viewport.scale
      ctx.fillRect(tx[4] - 1, tx[5] - h, w + 2, h * 1.2)
    }
    ctx.globalCompositeOperation = 'source-over'
  }
  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
    pageCount: doc.numPages,
    title: loaded.info.title,
    matched: m.first !== null,
    matchCount: m.count,
  }
}
