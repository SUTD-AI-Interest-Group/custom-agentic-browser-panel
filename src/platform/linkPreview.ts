// Client-side link previews for standalone links. host_permissions:["<all_urls>"]
// exempts these cross-origin reads from CORS, so no backend/proxy is needed.
// The OG parser is pure (testable without network); getLinkPreview adds a memory
// + chrome.storage.local cache and a timeout, and is gated by a privacy setting.

import { loadSettings } from '../data/settings'

/** Reject preview fetches to private/loopback/link-local/metadata hosts so an
 *  assistant-authored link can't drive an automatic request at an internal
 *  target (SSRF/info-disclosure). Does not defeat DNS-rebinding but blocks the
 *  obvious literal-host cases. */
function isSafePreviewTarget(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false
  }
  return true
}

/** OpenGraph-derived preview data; every field optional. */
export interface LinkPreview {
  title?: string
  description?: string
  image?: string
  siteName?: string
}

/** Extract OG/meta preview data from raw HTML. Returns null when nothing useful
 *  is present. `baseUrl` resolves a relative og:image. Pure — no network. */
export function parseOpenGraph(html: string, baseUrl: string): LinkPreview | null {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const meta = (sel: string): string | undefined => {
    const el = doc.querySelector(sel)
    const v = el?.getAttribute('content')?.trim()
    return v || undefined
  }
  const title = (meta('meta[property="og:title"]') ?? doc.querySelector('title')?.textContent?.trim()) || undefined
  const description =
    meta('meta[property="og:description"]') ?? meta('meta[name="description"]')
  const siteName = meta('meta[property="og:site_name"]')
  let image = meta('meta[property="og:image"]') ?? meta('meta[property="og:image:url"]')
  if (image) {
    try {
      image = new URL(image, baseUrl).href
    } catch {
      image = undefined
    }
  }
  if (!title && !description && !image && !siteName) return null
  return { title, description, image, siteName }
}

// ---------------------------------------------------------------------------
// Cache + fetch
// ---------------------------------------------------------------------------

const TTL_MS = 7 * 24 * 60 * 60 * 1000
const TIMEOUT_MS = 6000
const mem = new Map<string, LinkPreview | null>()

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
  if (mem.has(url)) return mem.get(url)!
  const settings = await loadSettings().catch(() => null)
  if (settings && settings.fetchLinkPreviews === false) return null

  if (!isSafePreviewTarget(url)) {
    mem.set(url, null)
    return null
  }

  const key = cacheKey(url)
  try {
    const stored = (await chrome.storage.local.get(key))[key] as CacheEntry | undefined
    if (stored && Date.now() - stored.ts < TTL_MS) {
      mem.set(url, stored.data)
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

  mem.set(url, data)
  try {
    await chrome.storage.local.set({ [key]: { data, ts: Date.now() } satisfies CacheEntry })
  } catch {
    // ignore storage write failures
  }
  return data
}
