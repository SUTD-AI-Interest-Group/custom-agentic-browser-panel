// Keyless, attribution-first extra modalities for the research agent: academic
// search (OpenAlex), image search (Wikimedia Commons + Openverse), and harvesting
// <img> assets from a page. Network helpers never throw — they return {error} or
// empty so the agent can move on. The pure parsers are unit-tested.
//
// No API keys (fits the no-backend/keyless stance). host_permissions:<all_urls>
// exempts these cross-origin GETs from CORS, so no proxy is needed.

const TIMEOUT_MS = 15_000

function timeout(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
}

// ---------------------------------------------------------------------------
// Academic search — OpenAlex (keyless, broad coverage, JSON).
// ---------------------------------------------------------------------------

export interface AcademicResult {
  title: string
  abstract: string
  authors: string[]
  year?: number
  url: string
  pdfUrl?: string
}

/** OpenAlex stores abstracts as an inverted index {word: [positions]}. Rebuild
 *  the plain text by placing each word at its position(s). Pure/testable. */
export function reconstructAbstract(inverted: Record<string, number[]> | null | undefined): string {
  if (!inverted) return ''
  const slots: string[] = []
  for (const [word, positions] of Object.entries(inverted)) {
    for (const p of positions) slots[p] = word
  }
  return slots.filter((w) => w !== undefined).join(' ').trim()
}

/** Map one OpenAlex work record to our shape. Pure/testable. */
export function parseOpenAlexWork(w: any): AcademicResult {
  return {
    title: (w?.title ?? w?.display_name ?? '').trim(),
    abstract: reconstructAbstract(w?.abstract_inverted_index).slice(0, 2000),
    authors: Array.isArray(w?.authorships)
      ? w.authorships.map((a: any) => a?.author?.display_name).filter(Boolean).slice(0, 8)
      : [],
    year: typeof w?.publication_year === 'number' ? w.publication_year : undefined,
    url: w?.primary_location?.landing_page_url || w?.id || (w?.doi ? `https://doi.org/${String(w.doi).replace(/^https?:\/\/doi\.org\//, '')}` : ''),
    pdfUrl: w?.open_access?.oa_url || w?.primary_location?.pdf_url || undefined,
  }
}

export async function searchAcademic(
  query: string,
  maxResults = 8,
  signal?: AbortSignal,
): Promise<{ results: AcademicResult[] } | { error: string }> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${Math.min(maxResults, 25)}`
  try {
    const res = await fetch(url, { credentials: 'omit', signal: timeout(signal) })
    if (!res.ok) return { error: `academic search failed: HTTP ${res.status}` }
    const json = (await res.json()) as { results?: any[] }
    const results = (json.results ?? []).map(parseOpenAlexWork).filter((r) => r.title && r.url)
    return { results }
  } catch (err) {
    return { error: `academic search error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ---------------------------------------------------------------------------
// Image search — Wikimedia Commons (rich license metadata) + Openverse (CC).
// ---------------------------------------------------------------------------

export interface ImageResult {
  url: string
  title: string
  sourcePageUrl?: string
  license?: string
  author?: string
  caption?: string
  dims?: { w: number; h: number }
}

/** Strip HTML tags Wikimedia leaves in extmetadata Artist/Description. Pure. */
function stripHtml(s: string | undefined): string {
  return (s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

/** Parse a Wikimedia Commons `query.pages` imageinfo response. Pure/testable. */
export function parseCommonsImages(json: any): ImageResult[] {
  const pages = json?.query?.pages
  if (!pages || typeof pages !== 'object') return []
  const out: ImageResult[] = []
  for (const page of Object.values(pages) as any[]) {
    const info = page?.imageinfo?.[0]
    if (!info?.url) continue
    // Skip non-images (Commons also indexes audio/video/pdf).
    if (info.mime && !/^image\//.test(info.mime)) continue
    const meta = info.extmetadata ?? {}
    out.push({
      url: info.url,
      title: String(page.title ?? '').replace(/^File:/, ''),
      sourcePageUrl: info.descriptionurl,
      license: stripHtml(meta.LicenseShortName?.value) || undefined,
      author: stripHtml(meta.Artist?.value) || undefined,
      caption: stripHtml(meta.ImageDescription?.value)?.slice(0, 300) || undefined,
      dims: info.width && info.height ? { w: info.width, h: info.height } : undefined,
    })
  }
  return out
}

async function searchCommons(query: string, maxResults: number, signal?: AbortSignal): Promise<ImageResult[]> {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '6', // File:
    gsrlimit: String(Math.min(maxResults, 20)),
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|mime|size',
    format: 'json',
    origin: '*',
  })
  try {
    const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { credentials: 'omit', signal: timeout(signal) })
    if (!res.ok) return []
    return parseCommonsImages(await res.json())
  } catch {
    return []
  }
}

/** Parse an Openverse images response. Pure/testable. */
export function parseOpenverse(json: any): ImageResult[] {
  const results = json?.results
  if (!Array.isArray(results)) return []
  return results
    .filter((r: any) => r?.url)
    .map((r: any) => ({
      url: r.url,
      title: (r.title ?? '').trim() || 'image',
      sourcePageUrl: r.foreign_landing_url,
      license: [r.license, r.license_version].filter(Boolean).join(' ').toUpperCase() || undefined,
      author: r.creator || undefined,
      dims: r.width && r.height ? { w: r.width, h: r.height } : undefined,
    }))
}

async function searchOpenverse(query: string, maxResults: number, signal?: AbortSignal): Promise<ImageResult[]> {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${Math.min(maxResults, 20)}`
  try {
    const res = await fetch(url, { credentials: 'omit', signal: timeout(signal) })
    if (!res.ok) return []
    return parseOpenverse(await res.json())
  } catch {
    return []
  }
}

/** Search Commons first (best license metadata), top up from Openverse. Deduped by URL. */
export async function searchImages(
  query: string,
  maxResults = 8,
  signal?: AbortSignal,
): Promise<{ results: ImageResult[] } | { error: string }> {
  const commons = await searchCommons(query, maxResults, signal)
  let results = commons
  if (results.length < maxResults) {
    const more = await searchOpenverse(query, maxResults - results.length, signal)
    const seen = new Set(results.map((r) => r.url))
    results = [...results, ...more.filter((r) => !seen.has(r.url))]
  }
  if (results.length === 0) return { error: 'no images found' }
  return { results: results.slice(0, maxResults) }
}

// ---------------------------------------------------------------------------
// Harvest <img> assets from a page's HTML (keyless — we already fetch pages).
// ---------------------------------------------------------------------------

/** Extract meaningful <img> from a page's HTML, resolving relative URLs and
 *  preferring a figure's <figcaption> / alt as the caption. Pure/testable. */
export function parseImgTags(html: string, baseUrl: string, max = 12): ImageResult[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const out: ImageResult[] = []
  const seen = new Set<string>()
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const raw = img.getAttribute('src') || img.getAttribute('data-src') || ''
    if (!raw) continue
    let abs: string
    try {
      abs = new URL(raw, baseUrl).toString()
    } catch {
      continue
    }
    if (!/^https?:\/\//i.test(abs) || seen.has(abs)) continue
    // Skip obvious sprites/icons/trackers.
    if (/sprite|icon|logo|avatar|pixel|1x1|spacer|blank\./i.test(abs)) continue
    const w = Number(img.getAttribute('width')) || 0
    const h = Number(img.getAttribute('height')) || 0
    if ((w && w < 100) || (h && h < 100)) continue
    const fig = img.closest('figure')
    const caption = (fig?.querySelector('figcaption')?.textContent || img.getAttribute('alt') || '').trim()
    seen.add(abs)
    out.push({ url: abs, title: caption || 'image', sourcePageUrl: baseUrl, caption: caption || undefined, dims: w && h ? { w, h } : undefined })
    if (out.length >= max) break
  }
  return out
}

export async function harvestImages(url: string, signal?: AbortSignal): Promise<{ results: ImageResult[] } | { error: string }> {
  try {
    const res = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: timeout(signal) })
    if (!res.ok) return { error: `fetch failed: HTTP ${res.status}` }
    const ct = res.headers.get('content-type') ?? ''
    if (!/text\/html|application\/xhtml/i.test(ct)) return { error: `not an HTML page: ${ct}` }
    const html = (await res.text()).slice(0, 2_000_000)
    return { results: parseImgTags(html, res.url) }
  } catch (err) {
    return { error: `harvest error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
