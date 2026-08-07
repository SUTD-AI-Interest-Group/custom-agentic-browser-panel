/// <reference types="vite/client" />
// PDF fetch/extract/render core. Chrome's PDF viewer is a plugin with no
// scriptable DOM, so a PDF tab cannot be read the way ordinary pages are
// (tabs.ts) — instead the bytes are fetched directly (host_permissions
// <all_urls> exempts the fetch from CORS) and processed here.
//
// TWO engines, split by what each can actually do:
//
//   • TEXT comes from pdf-inspector (Rust/lopdf compiled to WASM), off-thread
//     via pdfEngine.ts. It does position-aware extraction with multi-column
//     reading order, table detection and Markdown conversion — measured ~10x
//     faster than the pdf.js text walk it replaced, and structurally far better
//     (pdf.js could only join text items with spaces, which shredded two-column
//     papers and tables).
//
//   • PIXELS come from pdf.js, which stays because pdf-inspector has NO
//     rasterizer. ReadPdf mode:"view", the PDF HighlightContent path and the
//     attachment vision ladder all need a rendered page; so does the bookmark
//     outline, which pdf-inspector does not expose. pdf.js is therefore
//     dynamically imported ONLY on those paths — a text-only read never pays
//     for it.
//
// Context matters: both engines need a page-like environment (DOM, workers), so
// this module runs where its consumers already live — the side panel (ReadPdf)
// and the offscreen document (research's FetchUrl). The MV3 service worker
// never imports it.
//
// The pure logic lives next door and stays Chrome-free: range parsing, search
// and budgeting in pdfText.ts, the Markdown→PageText translation in
// pdfExtract.ts. Keep it that way.
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import { sniffPdf, flattenOutline, type PageText, type OutlineEntry, type OutlineNode } from './pdfText'
import { toPageTexts, stripMarkdown, type PdfType } from './pdfExtract'
import { getPdfEngine } from './pdfEngine'
import { findTextInChunks } from './highlightText'

/** An expected, explainable failure — the message is a sentence the model (and user) can act on. */
export class PdfError extends Error {}

export interface PdfInfo {
  /** Final URL after redirects. */
  url: string
  /** Document title (metadata), else the URL's filename. */
  title: string
  pageCount: number
  /** Pages whose text was actually extracted (≤ pageCount — huge docs are capped). */
  extractedPages: number
  /** pdf-inspector's classification — what the document IS, not a guess after the fact. */
  pdfType: PdfType
  /** 1-based pages with no text layer, i.e. the ones that need eyes on them. */
  pagesNeedingOcr: number[]
  /** True when the fonts decode badly enough that the text layer is unreliable. */
  hasEncodingIssues: boolean
}

export interface LoadedPdf {
  info: PdfInfo
  /** Extracted text, one entry per page, 1-based, in order. */
  pages: PageText[]
}

/** Bookmarks + author — pdf.js only, so they cost a parse (see loadPdfMeta). */
export interface PdfMeta {
  author: string
  outline: OutlineEntry[]
}

const MAX_PDF_BYTES = 50 * 1024 * 1024
const MAX_EXTRACT_PAGES = 500
const FETCH_TIMEOUT_MS = 30_000
// A loaded PDF is expensive (fetch + extract), and a Q&A session hammers the
// same document repeatedly — so keep a few alive. Small, because each holds the
// raw bytes and may hold a pdf.js doc handle (worker memory) for page rendering.
const CACHE_MAX = 3

interface CacheEntry {
  /**
   * The fetched bytes, retained. This is what makes rendering lazy: a text-only
   * read never parses with pdf.js at all, and a later render (or a second one,
   * or all 20 pages of an attachment) re-parses from here instead of re-fetching
   * the document. Bounded by CACHE_MAX × MAX_PDF_BYTES, and strictly cheaper
   * than the fully-parsed pdf.js documents this cache used to hold outright.
   */
  bytes: Uint8Array
  loaded: LoadedPdf
  /** pdf.js handle, created on first render/outline and memoized. */
  render?: Promise<{ task: PDFDocumentLoadingTask; doc: PDFDocumentProxy }>
  /** Bookmarks + author, created on first mode:"outline" and memoized. */
  meta?: Promise<PdfMeta>
}

// Keyed by credentials mode + URL; holds the in-flight promise so concurrent
// calls for the same document share one load. Map insertion order is the LRU.
const cache = new Map<string, Promise<CacheEntry>>()

// Counts callers currently "checked out" of a cache entry via getEntry/
// getBytesEntry (acquired before the caller's await, released in their
// finally). Concurrent history hydration can fire many renderPdfPageFromBytes
// calls across several distinct documents at once, all sharing this one small
// cache — an in-flight canvas render still holds the doc/task, and destroy()ing
// it out from under that caller aborts pdf.js's worker mid-operation. See
// planEviction.
const refCounts = new Map<string, number>()

function acquire(key: string) {
  refCounts.set(key, (refCounts.get(key) ?? 0) + 1)
}

function release(key: string) {
  const n = (refCounts.get(key) ?? 0) - 1
  if (n <= 0) refCounts.delete(key)
  else refCounts.set(key, n)
}

/**
 * Which cache keys to evict, oldest-first, to bring the cache back to `max`
 * entries — skipping any key `isInUse` flags rather than destroying it purely
 * by recency. Left over-capacity when every entry is in use (safety over
 * strict capacity). Pure and exported for testing; `evictExcess` is the
 * impure shell that acts on its answer (destroying the corresponding pdf.js
 * task, when one was ever created).
 */
export function planEviction(
  keysOldestFirst: string[],
  max: number,
  isInUse: (key: string) => boolean,
): string[] {
  const evict: string[] = []
  let size = keysOldestFirst.length
  for (const key of keysOldestFirst) {
    if (size <= max) break
    if (isInUse(key)) continue
    evict.push(key)
    size--
  }
  return evict
}

function evictExcess() {
  const doomed = planEviction([...cache.keys()], CACHE_MAX, (k) => (refCounts.get(k) ?? 0) > 0)
  for (const k of doomed) {
    const v = cache.get(k)
    cache.delete(k)
    // Only a render-touched entry holds worker memory; a text-only one is
    // plain data the GC reclaims on its own.
    v?.then((e) => e.render?.then((r) => r.task.destroy().catch(() => {})).catch(() => {})).catch(() => {})
  }
}

async function getPdfjs() {
  const [pdfjs, { default: workerUrl }] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
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
  return extractPdfBytes(bytes, finalUrl, filenameOf(finalUrl))
}

// Extract + build the cache entry, source-agnostic: doLoad hands over fetched
// bytes, the attachment path (getBytesEntry) hands over a dropped file's bytes.
async function extractPdfBytes(
  bytes: Uint8Array,
  sourceUrl: string,
  titleFallback: string,
): Promise<CacheEntry> {
  let r
  try {
    r = await getPdfEngine().extract(bytes)
  } catch (err) {
    // pdfEngine already mapped a parse failure to an actionable sentence
    // (pdfErrorMessage); anything else is an engine/transport fault.
    throw new PdfError(err instanceof Error ? err.message : String(err))
  }
  // Cap the per-page model the way the pdf.js path did: text past this point is
  // beyond any budget a consumer would spend anyway. pdfType/pagesNeedingOcr
  // still describe the WHOLE document, which is what makes them useful.
  const extractCount = Math.min(r.pageCount, MAX_EXTRACT_PAGES)
  return {
    bytes,
    loaded: {
      info: {
        url: sourceUrl,
        title: r.title.trim() || titleFallback,
        pageCount: r.pageCount,
        extractedPages: extractCount,
        pdfType: r.pdfType,
        pagesNeedingOcr: r.pagesNeedingOcr,
        hasEncodingIssues: r.hasEncodingIssues,
      },
      pages: toPageTexts(r.markdown, extractCount),
    },
  }
}

/**
 * The pdf.js document for an entry, parsed on first use and memoized. Only the
 * pixel/bookmark paths reach this — a text-only read never loads pdf.js at all.
 *
 * pdf.js TRANSFERS the buffer it is handed to its worker, detaching it. The
 * cache keeps `bytes` alive for exactly this reason (a second render, all 20
 * pages of an attachment), so it must always be handed a COPY. Keep this slice.
 */
function getRenderDoc(entry: CacheEntry) {
  if (!entry.render) {
    entry.render = (async () => {
      const pdfjs = await getPdfjs()
      const task = pdfjs.getDocument({ data: entry.bytes.slice() })
      try {
        return { task, doc: await task.promise }
      } catch (err) {
        task.destroy().catch(() => {})
        const name = err instanceof Error ? err.name : ''
        if (name === 'PasswordException') {
          throw new PdfError('This PDF is password-protected and cannot be read.')
        }
        throw new PdfError(
          `Could not render this PDF (${err instanceof Error ? err.message : String(err)}).`,
        )
      }
    })()
    // A failed parse must not poison the entry forever — the text side is still
    // perfectly usable, and a later render deserves a fresh attempt.
    entry.render.catch(() => {
      entry.render = undefined
    })
  }
  return entry.render
}

/** A checked-out cache entry plus the release the caller must call (in a
 * finally) once done touching its doc — see the refcount comment on `cache`. */
interface CheckedOutEntry {
  entry: CacheEntry
  release: () => void
}

// Shared tail of getEntry/getBytesEntry: refresh recency, acquire before
// eviction runs (so this freshly-touched key can never be the one evictExcess
// picks, even in a fully-saturated cache), then await.
async function checkOut(key: string, start: () => Promise<CacheEntry>): Promise<CheckedOutEntry> {
  let pending = cache.get(key)
  if (pending) {
    // Refresh recency (Map order is the LRU order).
    cache.delete(key)
    cache.set(key, pending)
  } else {
    pending = start()
    cache.set(key, pending)
    pending.catch(() => cache.delete(key))
  }
  acquire(key)
  evictExcess()
  try {
    const entry = await pending
    return { entry, release: () => release(key) }
  } catch (err) {
    release(key) // the load failed — no caller will get a release() to call
    throw err
  }
}

function getEntry(
  url: string,
  opts?: { credentials?: RequestCredentials; signal?: AbortSignal },
): Promise<CheckedOutEntry> {
  const credentials = opts?.credentials ?? 'omit'
  return checkOut(`${credentials}:${url}`, () => doLoad(url, credentials, opts?.signal))
}

/**
 * Fetch and extract a PDF, returning its metadata and per-page text. Cached (a
 * few docs, LRU), so repeated search/read/view calls on the same document cost
 * one fetch+extract. Throws PdfError with an actionable sentence on every
 * expected failure (not a PDF, password, oversize, file-access…).
 *
 * Bookmarks and author are NOT here — they cost a pdf.js parse; see loadPdfMeta.
 */
export async function loadPdf(
  url: string,
  opts?: { credentials?: RequestCredentials; signal?: AbortSignal },
): Promise<LoadedPdf> {
  const { entry, release } = await getEntry(url, opts)
  release() // .loaded is already fully computed — no further async work to protect
  return entry.loaded
}

/**
 * Bookmarks + author for a PDF. Separate from loadPdf because pdf-inspector
 * exposes neither, so answering costs a pdf.js parse that only ReadPdf
 * mode:"outline" ever wants to pay. Best-effort: a document pdf.js cannot open
 * yields empty values rather than failing the whole call, and the caller falls
 * back to showing the first page's text.
 */
export async function loadPdfMeta(
  url: string,
  opts?: { credentials?: RequestCredentials; signal?: AbortSignal },
): Promise<PdfMeta> {
  const { entry, release } = await getEntry(url, opts)
  try {
    if (!entry.meta) {
      entry.meta = (async () => {
        const { doc } = await getRenderDoc(entry)
        const meta = await doc.getMetadata().catch(() => null)
        const info = (meta?.info ?? {}) as Record<string, unknown>
        return {
          author: typeof info.Author === 'string' ? info.Author : '',
          outline: await resolveOutline(doc),
        }
      })()
      entry.meta.catch(() => {
        entry.meta = undefined
      })
    }
    return await entry.meta
  } catch {
    return { author: '', outline: [] }
  } finally {
    release()
  }
}

/**
 * Byte-source variant of getEntry, for PDFs that have no URL (a user-dropped
 * file). Cached under `bytes:<key>` in the same LRU, so the 20 sequential page
 * renders of one attached document extract it once. `key` is the attachment id.
 */
async function getBytesEntry(
  bytes: Uint8Array,
  key: string,
  titleFallback?: string,
): Promise<CheckedOutEntry> {
  const cacheKey = `bytes:${key}`
  if (!cache.has(cacheKey)) {
    if (bytes.byteLength > MAX_PDF_BYTES) throw new PdfError('This PDF is larger than the 50 MB limit.')
    if (!sniffPdf(bytes)) throw new PdfError('This file is not a PDF (no %PDF header found).')
  }
  // No defensive copy needed here: pdfEngine copies before transferring, and
  // getRenderDoc copies before handing bytes to pdf.js. Both engines detach
  // what they are given, and both are fed copies — the attachment's own array
  // is never the one that goes over a boundary.
  return checkOut(cacheKey, () => extractPdfBytes(bytes, `attachment:${key}`, titleFallback ?? key))
}

/** loadPdf for raw bytes (a dropped file). Same caching, errors, and shape. */
export async function loadPdfFromBytes(
  bytes: Uint8Array,
  key: string,
  titleFallback?: string,
): Promise<LoadedPdf> {
  const { entry, release } = await getBytesEntry(bytes, key, titleFallback)
  release() // .loaded is already fully computed — no further async work to protect
  return entry.loaded
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

/** Shared body of the two plain-render entry points. */
async function renderFromEntry(
  { entry, release }: CheckedOutEntry,
  pageNumber: number,
): Promise<{ dataUrl: string; width: number; height: number; pageCount: number; title: string }> {
  try {
    const { doc } = await getRenderDoc(entry)
    if (pageNumber < 1 || pageNumber > doc.numPages) {
      throw new PdfError(`No page ${pageNumber} — this PDF has ${doc.numPages} pages.`)
    }
    const { canvas } = await renderPageToCanvas(doc, pageNumber)
    return {
      dataUrl: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
      pageCount: doc.numPages,
      title: entry.loaded.info.title,
    }
  } finally {
    release()
  }
}

/**
 * Render one page (1-based) to a PNG data URL. Shares loadPdf's document cache,
 * so a page already read as text renders without re-fetching. Runs only where a
 * DOM canvas exists (side panel) — the research path never renders.
 */
export async function renderPdfPage(
  url: string,
  pageNumber: number,
  opts?: { credentials?: RequestCredentials; signal?: AbortSignal },
) {
  return renderFromEntry(await getEntry(url, opts), pageNumber)
}

/** renderPdfPage for raw bytes (a dropped file). Shares the bytes: cache entry. */
export async function renderPdfPageFromBytes(bytes: Uint8Array, key: string, pageNumber: number) {
  return renderFromEntry(await getBytesEntry(bytes, key), pageNumber)
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
  const { entry, release } = await getEntry(url, opts)
  try {
    const { doc } = await getRenderDoc(entry)
    if (pageNumber < 1 || pageNumber > doc.numPages) {
      throw new PdfError(`No page ${pageNumber} — this PDF has ${doc.numPages} pages.`)
    }
    const { page, canvas, ctx, viewport } = await renderPageToCanvas(doc, pageNumber)
    const content = await page.getTextContent()
    const items = (content.items as unknown[]).filter(
      (it): it is PdfTextItem => typeof (it as PdfTextItem).str === 'string',
    )
    // The passage is matched against pdf.js TEXT ITEMS, which carry no Markdown
    // — but the model got its text from ReadPdf, which serves pdf-inspector's
    // Markdown, so a quoted passage can arrive as "**Encoder:** The encoder…".
    // Strip it to the words a reader sees, or the highlight silently misses.
    const m = findTextInChunks(items.map((it) => it.str), stripMarkdown(query))
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
      title: entry.loaded.info.title,
      matched: m.first !== null,
      matchCount: m.count,
    }
  } finally {
    release()
  }
}
