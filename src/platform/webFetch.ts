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
  const h = u.hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h === '0.0.0.0' || h === '::1' || h === '[::1]') {
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
      ?? row?.parentElement?.querySelector('.result-snippet')
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
  const text = (root?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim()
  return { title, text: text.slice(0, maxChars) }
}
