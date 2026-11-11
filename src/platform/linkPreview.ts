import { parseExtractionHtml, htmlText, htmlAttr, findHtml } from './extractionHtml'
// Client-side link previews for standalone links. host_permissions:["<all_urls>"]
// exempts these cross-origin reads from CORS, so no backend/proxy is needed.
// The OG parser is pure (testable without network); getLinkPreview adds a memory
// + chrome.storage.local cache and a timeout, and is gated by a privacy setting.

import { loadSettings } from '../data/settings'
import { isSafeRenderUrl } from './safeRenderUrl'

// Both the outer page URL (fetched below) and the og:image URL extracted
// from that page's own HTML (in parseOpenGraph) are automatic, no-click,
// no-approval-card fetches — so both are screened by the same shared,
// hardened guard (isSafeRenderUrl, ./safeRenderUrl) before being used. The
// image is a page-supplied value: a hostile page can declare an og:image
// pointing at an internal target, and rendering it unchecked would be an
// automatic GET to wherever the page's HTML pointed it.

/** OpenGraph-derived preview data; every field optional. */
export interface LinkPreview {
  title?: string
  description?: string
  image?: string
  siteName?: string
}

/** Extract OG/meta preview data from raw HTML. Returns null when nothing useful
 *  is present. `baseUrl` resolves a relative og:image. Pure — no network.
 *  The resolved image URL is screened by `isSafeRenderUrl` before being
 *  returned — a hostile page can declare `og:image` pointing at an internal
 *  target, and this preview renders straight into `<img src>` with no click
 *  and no approval card, so a rejected image is dropped (set to undefined)
 *  rather than failing the whole preview: the title/description/siteName
 *  are unaffected. */
export function parseOpenGraph(html: string, baseUrl: string): LinkPreview | null {
  const doc = parseExtractionHtml(html)
  const meta = (attribute: string, value: string): string | undefined => {
    const node = findHtml(doc, node => node.tagName === 'meta' && htmlAttr(node, attribute) === value)
    return (node ? htmlAttr(node, 'content').trim() : '') || undefined
  }
  const title = (meta('property', 'og:title') ?? htmlText(findHtml(doc, node => node.tagName === 'title')).trim()) || undefined
  const description = meta('property', 'og:description') ?? meta('name', 'description')
  const siteName = meta('property', 'og:site_name')
  let image = meta('property', 'og:image') ?? meta('property', 'og:image:url')
  if (image) {
    try {
      image = new URL(image, baseUrl).href
    } catch {
      image = undefined
    }
  }
  if (image && !isSafeRenderUrl(image)) image = undefined
  if (!title && !description && !image && !siteName) return null
  return { title, description, image, siteName }
}

// ---------------------------------------------------------------------------
// Cache + fetch
// ---------------------------------------------------------------------------

const TTL_MS = 7 * 24 * 60 * 60 * 1000
const TIMEOUT_MS = 6000
const CACHE_MAX = 128
const mem = new Map<string, CacheEntry>()
const pending = new Map<string, Promise<LinkPreview | null>>()
function remember(url: string, data: LinkPreview | null) {
  mem.delete(url)
  mem.set(url, { data, ts: Date.now() })
  while (mem.size > CACHE_MAX) mem.delete(mem.keys().next().value!)
}

interface CacheEntry {
  data: LinkPreview | null
  ts: number
}

function cacheKey(url: string): string {
  return `linkPreview:${url}`
}

// Limits how many live fetches run at once so a long link list doesn't fire
// a burst of parallel requests.
const MAX_CONCURRENT = 4
let active = 0
const waiters: (() => void)[] = []
async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) { active++; return }
  await new Promise<void>((resolve) => waiters.push(resolve))
  active++
}
function release(): void {
  active--
  const next = waiters.shift()
  if (next) next()
}

/** Cached OpenGraph preview for `url`. Returns null when disabled, cached-null,
 *  or on any fetch/parse failure (caller falls back to favicon + domain). */
export async function getLinkPreview(url: string): Promise<LinkPreview | null> {
  const settings = await loadSettings().catch(() => null)
  if (settings && settings.fetchLinkPreviews === false) return null
  const cached = mem.get(url)
  if (cached && Date.now() - cached.ts < TTL_MS) {
    mem.delete(url); mem.set(url, cached)
    return cached.data
  }
  mem.delete(url)
  const existing = pending.get(url)
  if (existing) return existing
  const request = fetchPreview(url).finally(() => pending.delete(url))
  pending.set(url, request)
  return request
}

async function fetchPreview(url: string): Promise<LinkPreview | null> {

  if (!isSafeRenderUrl(url)) {
    remember(url, null)
    return null
  }

  const key = cacheKey(url)
  try {
    const stored = (await chrome.storage.local.get(key))[key] as CacheEntry | undefined
    if (stored && Date.now() - stored.ts < TTL_MS) {
      remember(url, stored.data)
      return stored.data
    }
  } catch {
    // storage unavailable — fall through to a live fetch
  }

  let data: LinkPreview | null = null
  await acquire()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' })
    if (res.ok && (res.headers.get('content-type') ?? '').includes('text/html')) {
      data = parseOpenGraph(await res.text(), res.url || url)
    }
  } catch {
    data = null
  } finally {
    release()
  }

  remember(url, data)
  try {
    await chrome.storage.local.set({ [key]: { data, ts: Date.now() } satisfies CacheEntry })
  } catch {
    // ignore storage write failures
  }
  return data
}
