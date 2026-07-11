/**
 * Tolerant JSON parse for model output that may be fenced or wrapped in prose.
 * Strips ```json fences, then falls back to the outermost brace/bracket span.
 * Throws if nothing parses — callers treat that as an extraction failure.
 */
export function parseJsonLoose(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?/gi, '').trim()
  try {
    return JSON.parse(unfenced)
  } catch {}
  const start = unfenced.search(/[[{]/)
  const end = Math.max(unfenced.lastIndexOf('}'), unfenced.lastIndexOf(']'))
  if (start === -1 || end <= start) throw new Error('no JSON found in text')
  return JSON.parse(unfenced.slice(start, end + 1))
}

/** True only for public http(s) URLs — blocks localhost/private-IP/link-local/.local and non-web schemes (SSRF guard). */
export function isFetchableUrl(raw: string): { ok: boolean; reason?: string } {
  let u: URL
  try { u = new URL(raw) } catch { return { ok: false, reason: 'invalid URL' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `blocked scheme ${u.protocol}` }
  const h = u.hostname.toLowerCase().replace(/\.+$/, '')
  if (h.startsWith('[')) return { ok: false, reason: 'blocked IPv6 literal' }
  if (h === 'localhost' || h.endsWith('.local') || h === '0.0.0.0') {
    return { ok: false, reason: 'blocked host' }
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
      return { ok: false, reason: 'blocked private IP' }
    }
  }
  return { ok: true }
}

/** Parse the lite.duckduckgo.com/lite result table into ranked rows. Fragile by nature — tolerant of missing snippets. */
export function parseDuckDuckGoLite(html: string): { title: string; url: string; snippet: string }[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const links = Array.from(doc.querySelectorAll('a.result-link')) as HTMLAnchorElement[]
  const resolve = (href: string): string => {
    try {
      const abs = href.startsWith('//') ? `https:${href}` : href
      const u = new URL(abs, 'https://duckduckgo.com')
      const uddg = u.searchParams.get('uddg')
      return uddg ? decodeURIComponent(uddg) : abs
    } catch { return href }
  }
  return links.map((a) => {
    // The snippet cell is the next .result-snippet after this link's row.
    let snippet = ''
    const row = a.closest('tr')
    const snipCell = row?.nextElementSibling?.querySelector('.result-snippet')
    if (snipCell) snippet = (snipCell.textContent ?? '').trim()
    return { title: (a.textContent ?? '').trim(), url: resolve(a.getAttribute('href') ?? ''), snippet }
  }).filter((r) => r.title && r.url)
}

/** Reduce a fetched HTML document to readable text: strip chrome, prefer <main>/<article>, collapse whitespace, cap length. */
export function extractReadableText(html: string, maxChars = 20_000): { title: string; text: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const title = (doc.querySelector('title')?.textContent ?? '').trim()
  doc.querySelectorAll('script,style,noscript,nav,footer,header,aside,form,svg').forEach((n) => n.remove())
  const root = doc.querySelector('main') ?? doc.querySelector('article') ?? doc.body
  // Block elements carry no separator between siblings, so adjacent blocks' text runs together
  // (e.g. "<p>A</p><p>B</p>" -> "AB"). Insert a newline after each so words stay separated.
  root?.querySelectorAll('p,div,section,article,h1,h2,h3,h4,h5,h6,li,br,tr,td,th,blockquote,pre').forEach((el) => el.after(doc.createTextNode('\n')))
  const text = (root?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim()
  return { title, text: text.slice(0, maxChars) }
}

const FETCH_TIMEOUT_MS = 15_000
const MAX_BYTES = 2_000_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Read a response body up to `maxBytes`, then stop — bounds memory for hostile/huge responses. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  const out = new Uint8Array(Math.min(total, maxBytes))
  let off = 0
  for (const c of chunks) {
    if (off >= out.byteLength) break
    const take = Math.min(c.byteLength, out.byteLength - off)
    out.set(c.subarray(0, take), off)
    off += take
  }
  return new TextDecoder().decode(out)
}

/** Search DuckDuckGo (keyless lite endpoint) with retry/backoff. Never throws — returns {error} on failure so callers can react. */
export async function searchDuckDuckGo(
  query: string,
  maxResults = 8,
  signal?: AbortSignal,
): Promise<{ results: ReturnType<typeof parseDuckDuckGoLite> } | { error: string }> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'omit',
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.status === 202 || res.status === 429) { await sleep(400 * (attempt + 1)); continue }
      if (!res.ok) return { error: `search failed: HTTP ${res.status}` }
      const results = parseDuckDuckGoLite(await res.text()).slice(0, Math.min(maxResults, 20))
      return { results }
    } catch (err) {
      if (attempt === 2) return { error: `search error: ${err instanceof Error ? err.message : String(err)}` }
      await sleep(400 * (attempt + 1))
    }
  }
  return { error: 'search failed after retries' }
}

/** Fetch a public page and return its readable text. SSRF-guarded, credentials omitted, timed, size-capped. Never throws. */
export async function fetchReadable(
  url: string,
  signal?: AbortSignal,
): Promise<{ url: string; title: string; text: string } | { error: string }> {
  const guard = isFetchableUrl(url)
  if (!guard.ok) return { error: `refused to fetch (${guard.reason})` }
  try {
    const res = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return { error: `fetch failed: HTTP ${res.status}` }
    const ct = res.headers.get('content-type') ?? ''
    if (!/text\/html|text\/plain|application\/xhtml/i.test(ct)) return { error: `unsupported content-type: ${ct}` }
    const body = await readCapped(res, MAX_BYTES)
    const { title, text } = extractReadableText(body)
    return { url: res.url, title, text }
  } catch (err) {
    return { error: `fetch error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
