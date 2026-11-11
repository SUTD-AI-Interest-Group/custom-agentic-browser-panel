import { parseExtractionHtml, htmlElements, htmlText, htmlAttr, hasHtmlClass, closestHtml, nextHtmlSibling, findHtml } from './extractionHtml'

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

// Fixed, well-known cloud metadata hostnames — reachable by design via a plain
// hostname specifically to dodge IP-based filters (GCP's is the canonical
// example: metadata.google.internal, or its bare "metadata" shorthand inside a
// GCE network). Unlike DNS rebinding (a hostname whose A-record happens to
// point somewhere private — see the KNOWN RESIDUAL RISK comment below), these
// are fixed literal names, so a denylist works without needing resolution.
const METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata'])

/** True only for public http(s) URLs — blocks localhost/private-IP/link-local/.local and non-web schemes (SSRF guard). */
export function isFetchableUrl(raw: string): { ok: boolean; reason?: string } {
  let u: URL
  try { u = new URL(raw) } catch { return { ok: false, reason: 'invalid URL' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `blocked scheme ${u.protocol}` }
  const h = u.hostname.toLowerCase().replace(/\.+$/, '')
  if (h.startsWith('[')) return { ok: false, reason: 'blocked IPv6 literal' }
  if (h === 'localhost' || h.endsWith('.local') || h === '0.0.0.0' || METADATA_HOSTNAMES.has(h)) {
    return { ok: false, reason: 'blocked host' }
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (
      a === 127 ||
      a === 10 ||
      a === 0 || // the rest of 0.0.0.0/8 ("this network") — Linux commonly routes it to loopback
      (a === 100 && b >= 64 && b <= 127) || // RFC 6598 carrier-grade NAT — Alibaba Cloud's metadata service lives at 100.100.100.200
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    ) {
      return { ok: false, reason: 'blocked private IP' }
    }
    // A normal public dotted-decimal quad (e.g. 8.8.8.8) — allow it. Returning
    // here (rather than falling through) is required so it never reaches the
    // non-standard-encoding check below, which would otherwise flag it too
    // (every octet is all-digit).
    return { ok: true }
  }
  // Chrome's URL parser accepts several alternate spellings of an IPv4 address
  // that the plain dotted-quad regex above does not match, and still resolves
  // them to a real IP before connecting — so each can smuggle a loopback/
  // private target past the checks above:
  //   - a bare decimal integer host:      http://2130706433/     (=127.0.0.1)
  //   - a bare hex integer host:          http://0x7f000001/     (=127.0.0.1)
  //   - a dotted host with octal octets:  http://0177.0.0.1/     (0177 oct=127)
  //   - a dotted host with hex octets:    http://0x7f.0.0.1/     (0x7f=127)
  // None of these is a real DNS hostname (a genuine domain always has at
  // least one non-IP-shaped label), so refuse anything where every
  // dot-separated label is decimal/octal/hex-integer-shaped wholesale, rather
  // than trying to decode and range-check every base individually.
  const labels = h.split('.')
  const isIpLikeLabel = (l: string) => /^0x[0-9a-f]+$/.test(l) || /^0[0-7]+$/.test(l) || /^\d+$/.test(l)
  if (labels.every(isIpLikeLabel)) {
    return { ok: false, reason: 'blocked non-standard IP form' }
  }
  // KNOWN RESIDUAL RISK: a normal-looking hostname whose DNS A-record points
  // at a private/loopback address (DNS rebinding — e.g. "127.0.0.1.nip.io",
  // a public DNS name that resolves straight to 127.0.0.1) cannot be caught
  // by string inspection alone: it has letters, so it looks exactly like any
  // other public hostname until resolved. Doing that resolution isn't
  // feasible pre-connect here, so it is NOT blocked by this function. A pass
  // from isFetchableUrl rules out the literal-host bypasses above; it is not
  // proof the eventual connection lands on a public address.
  return { ok: true }
}

export interface SearchResultRow { title: string; url: string; snippet: string }

/** DuckDuckGo wraps every outbound link as `//duckduckgo.com/l/?uddg=<real>`;
 *  unwrap it back to the real destination. Tolerant of a bare or protocol-less href. */
export function resolveDdgHref(href: string): string {
  try {
    const abs = href.startsWith('//') ? `https:${href}` : href
    const u = new URL(abs, 'https://duckduckgo.com')
    // URLSearchParams.get() already fully percent-decodes the value per the
    // x-www-form-urlencoded algorithm — a second decodeURIComponent() here
    // (the previous behavior) double-decodes any target URL that carries its
    // own percent-escapes (an encoded space/%/&/# in its own query string),
    // corrupting it. uddg is already the real, decoded target.
    const uddg = u.searchParams.get('uddg')
    return uddg || abs
  } catch {
    return href
  }
}

/** Parse the lite.duckduckgo.com/lite result table into ranked rows. Fragile by nature — tolerant of missing snippets. */
export function parseDuckDuckGoLite(html: string): SearchResultRow[] {
  const doc = parseExtractionHtml(html)
  const links = Array.from(htmlElements(doc)).filter(node => node.tagName === 'a' && hasHtmlClass(node, 'result-link'))
  return links.map(a => {
    const row = closestHtml(a, 'tr')
    const next = row && nextHtmlSibling(row)
    const snippet = next ? findHtml(next, node => hasHtmlClass(node, 'result-snippet')) : undefined
    return { title: htmlText(a).trim(), url: resolveDdgHref(htmlAttr(a, 'href')), snippet: htmlText(snippet).trim() }
  }).filter(r => r.title && r.url)
}

/**
 * Parse the html.duckduckgo.com/html result page (`.result__a` links) into rows.
 * This is the endpoint the tab-search fallback loads, since its per-result markup
 * carries the snippet inline — simpler and less positional than the lite table.
 */
export function parseDuckDuckGoHtml(html: string): SearchResultRow[] {
  const doc = parseExtractionHtml(html)
  const results = Array.from(htmlElements(doc)).filter(node => hasHtmlClass(node, 'result') || hasHtmlClass(node, 'web-result'))
  const rows: SearchResultRow[] = []
  for (const result of results) {
    const a = findHtml(result, node => node.tagName === 'a' && hasHtmlClass(node, 'result__a'))
    if (!a) continue
    const href = htmlAttr(a, 'href')
    if (!href || href.includes('duckduckgo.com/y.js')) continue
    const snippet = htmlText(findHtml(result, node => hasHtmlClass(node, 'result__snippet'))).trim()
    const title = htmlText(a).trim()
    const url = resolveDdgHref(href)
    if (title && url) rows.push({ title, url, snippet })
  }
  return rows
}

/** Reduce a fetched HTML document to readable text: strip chrome, prefer <main>/<article>, collapse whitespace, cap length. */
export function extractReadableText(html: string, maxChars = 20_000): { title: string; text: string } {
  const doc = parseExtractionHtml(html)
  const title = htmlText(findHtml(doc, node => node.tagName === 'title')).trim()
  const exclude = new Set(['script','style','noscript','nav','footer','header','aside','form','svg'])
  const root = findHtml(doc, node => node.tagName === 'main', exclude)
    ?? findHtml(doc, node => node.tagName === 'article', exclude)
    ?? findHtml(doc, node => node.tagName === 'body')
  const blocks = new Set(['p','div','section','article','h1','h2','h3','h4','h5','h6','li','br','tr','td','th','blockquote','pre'])
  const text = htmlText(root, exclude, blocks).replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim()
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
        // NB: `User-Agent` is a forbidden header for fetch() — the browser drops
        // any value we set and sends its own, so there is no point trying to spoof
        // it here. `Accept-Language` IS honored and nudges DDG toward an English
        // result page. When this keyless path is rate-limited (202/429), the real
        // fix is the tab-search fallback (searchInTab), not a header tweak.
        headers: { 'Accept-Language': 'en-US,en;q=0.9' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      // 202/429 is DDG's "prove you're a real browser" throttle — a plain fetch
      // can't clear it, so surface a distinct, recognizable error the caller can
      // escalate on (rather than the generic one, which reads as a dead end).
      if (res.status === 202 || res.status === 429) { await sleep(400 * (attempt + 1)); continue }
      if (!res.ok) return { error: `search failed: HTTP ${res.status}` }
      const results = parseDuckDuckGoLite(await res.text()).slice(0, Math.min(maxResults, 20))
      return { results }
    } catch (err) {
      if (attempt === 2) return { error: `search error: ${err instanceof Error ? err.message : String(err)}` }
      await sleep(400 * (attempt + 1))
    }
  }
  return { error: SEARCH_RATE_LIMITED }
}

/** Sentinel error from searchDuckDuckGo when the keyless endpoint throttled every
 *  attempt (202/429) — the caller escalates to a real tab on exactly this. */
export const SEARCH_RATE_LIMITED = 'search rate-limited (bot protection)'

/** Sentinel error from fetchReadable when the response is a PDF — the caller
 *  (research's FetchUrl) escalates to the pdf.js extractor on exactly this,
 *  never to a rendered tab (Chrome's PDF viewer has no DOM text to scrape). */
export const PDF_CONTENT = 'pdf content'

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
    // A public URL can 302 to a private/loopback target (e.g. an SSRF-fond
    // redirector, or a metadata-endpoint bounce) — `redirect: 'follow'` walks
    // it transparently, so the guard above (which only saw the *input* URL)
    // is not enough on its own. `redirect: 'manual'` would let us inspect each
    // hop before following it, but that yields an opaque-redirect response
    // whose Location header the Fetch API refuses to expose — manual hop-
    // walking is not possible from an extension/browser context. The
    // feasible fallback is to re-check `res.url` (the final, already-followed
    // URL) after the fact and refuse to hand back a body if it landed
    // somewhere blocked. The request to the blocked target has already been
    // made by this point — that part can't be undone — but discarding the
    // body here stops the blocked content from ever reaching the model or
    // the research notebook.
    const finalGuard = isFetchableUrl(res.url)
    if (!finalGuard.ok) return { error: `refused: redirected to a blocked target (${finalGuard.reason})` }
    if (!res.ok) return { error: `fetch failed: HTTP ${res.status}` }
    const ct = res.headers.get('content-type') ?? ''
    if (/application\/pdf/i.test(ct)) return { error: PDF_CONTENT }
    if (!/text\/html|text\/plain|application\/xhtml/i.test(ct)) return { error: `unsupported content-type: ${ct}` }
    const body = await readCapped(res, MAX_BYTES)
    const { title, text } = extractReadableText(body)
    return { url: res.url, title, text }
  } catch (err) {
    return { error: `fetch error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
