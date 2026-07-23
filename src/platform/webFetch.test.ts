import { test, expect, vi, afterEach } from 'vitest'
import { parseJsonLoose, isFetchableUrl, parseDuckDuckGoLite, parseDuckDuckGoHtml, resolveDdgHref, extractReadableText, fetchReadable } from './webFetch'

test('parses fenced json', () => {
  expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 })
})
test('parses json with surrounding prose', () => {
  expect(parseJsonLoose('Sure! {"a":2} done')).toEqual({ a: 2 })
})
test('parses top-level array', () => {
  expect(parseJsonLoose('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }])
})
test('throws on non-json', () => {
  expect(() => parseJsonLoose('nope')).toThrow()
})

test('SSRF guard rejects localhost + private ranges + non-http', () => {
  expect(isFetchableUrl('https://example.com').ok).toBe(true)
  expect(isFetchableUrl('http://localhost/x').ok).toBe(false)
  expect(isFetchableUrl('http://127.0.0.1').ok).toBe(false)
  expect(isFetchableUrl('http://10.1.2.3').ok).toBe(false)
  expect(isFetchableUrl('http://192.168.0.1').ok).toBe(false)
  expect(isFetchableUrl('http://169.254.1.1').ok).toBe(false)
  expect(isFetchableUrl('file:///etc/passwd').ok).toBe(false)
  expect(isFetchableUrl('http://printer.local').ok).toBe(false)
})

test('parses DDG-lite result rows', () => {
  const html = `<table><tr><td>1.</td><td>
    <a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fp&rut=x">A Title</a></td></tr>
    <tr><td class="result-snippet">A snippet.</td></tr>
    <tr><td><a class="result-link" href="https://b.com">B Title</a></td></tr></table>`
  const rows = parseDuckDuckGoLite(html)
  expect(rows[0]).toEqual({ title: 'A Title', url: 'https://a.com/p', snippet: 'A snippet.' })
  expect(rows[1].url).toBe('https://b.com')
})

test('parses DDG-html result rows with inline snippets', () => {
  const html = `<div>
    <div class="result results_links web-result">
      <div class="links_main">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fp&rut=x">A Title</a>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fp">A snippet.</a>
      </div>
    </div>
    <div class="result web-result">
      <div class="links_main"><a class="result__a" href="https://b.com">B Title</a></div>
    </div>
  </div>`
  const rows = parseDuckDuckGoHtml(html)
  expect(rows[0]).toEqual({ title: 'A Title', url: 'https://a.com/p', snippet: 'A snippet.' })
  expect(rows[1]).toEqual({ title: 'B Title', url: 'https://b.com', snippet: '' })
})

test('DDG-html parser skips ad rows (y.js tracking href)', () => {
  const html = `<div>
    <div class="result result--ad web-result"><div class="links_main">
      <a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Sponsored</a></div></div>
    <div class="result web-result"><div class="links_main">
      <a class="result__a" href="https://real.com">Real</a></div></div>
  </div>`
  const rows = parseDuckDuckGoHtml(html)
  expect(rows).toHaveLength(1)
  expect(rows[0].url).toBe('https://real.com')
})

test('resolveDdgHref unwraps the uddg redirect and passes plain URLs through', () => {
  expect(resolveDdgHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com%2Fa%3Fb%3D1')).toBe('https://x.com/a?b=1')
  expect(resolveDdgHref('https://plain.com/p')).toBe('https://plain.com/p')
})

test('SSRF guard rejects trailing-dot localhost bypass', () => {
  expect(isFetchableUrl('http://localhost./').ok).toBe(false)
})

test('SSRF guard rejects multiple-trailing-dot bypass', () => {
  expect(isFetchableUrl('http://localhost../').ok).toBe(false)
  expect(isFetchableUrl('http://127.0.0.1../').ok).toBe(false)
})

test('SSRF guard rejects IPv4-mapped IPv6 literal bypass', () => {
  expect(isFetchableUrl('http://[::ffff:127.0.0.1]').ok).toBe(false)
  expect(isFetchableUrl('http://[::ffff:169.254.169.254]').ok).toBe(false)
})

test('SSRF guard still allows normal public URLs', () => {
  expect(isFetchableUrl('https://example.com').ok).toBe(true)
})

test('DDG-lite snippet does not leak across rows when only one row has a snippet', () => {
  const html = `<table><tr><td>1.</td><td>
    <a class="result-link" href="https://a.com">A Title</a></td></tr>
    <tr><td class="result-snippet">A snippet.</td></tr>
    <tr><td>2.</td><td>
    <a class="result-link" href="https://b.com">B Title</a></td></tr></table>`
  const rows = parseDuckDuckGoLite(html)
  expect(rows[0].snippet).toBe('A snippet.')
  expect(rows[1].snippet).toBe('')
})

test('extractReadableText prefers main and strips chrome', () => {
  const html = `<html><head><title>T</title></head><body>
    <nav>menu</nav><script>x()</script>
    <main><h1>Head</h1><p>Body text here.</p></main><footer>foot</footer></body></html>`
  const { title, text } = extractReadableText(html)
  expect(title).toBe('T')
  expect(text).toContain('Body text here.')
  expect(text).not.toContain('menu')
  expect(text).not.toContain('foot')
})

test('extractReadableText inserts separators between adjacent block elements', () => {
  const { text } = extractReadableText('<main><p>Alpha</p><p>Beta</p></main>')
  expect(text).toMatch(/Alpha\s+Beta/)
})

test('extractReadableText separates adjacent table cells', () => {
  const { text } = extractReadableText('<main><table><tr><td>Cell1</td><td>Cell2</td></tr></table></main>')
  expect(text).toMatch(/Cell1\s+Cell2/)
})

// --- S2: non-standard IP encodings ---------------------------------------

test('SSRF guard rejects a bare decimal-integer host (127.0.0.1 as a u32)', () => {
  expect(isFetchableUrl('http://2130706433/').ok).toBe(false)
})

test('SSRF guard rejects a bare hex-integer host (127.0.0.1 as hex)', () => {
  expect(isFetchableUrl('http://0x7f000001/').ok).toBe(false)
})

test('SSRF guard rejects dotted hosts with octal octets', () => {
  expect(isFetchableUrl('http://0177.0.0.1/').ok).toBe(false)
})

test('SSRF guard rejects dotted hosts with hex octets', () => {
  expect(isFetchableUrl('http://0x7f.0.0.1/').ok).toBe(false)
})

test('SSRF guard still allows a normal public dotted-decimal IP', () => {
  expect(isFetchableUrl('http://8.8.8.8/').ok).toBe(true)
})

test('SSRF guard still allows normal public https URLs', () => {
  expect(isFetchableUrl('https://example.com/page').ok).toBe(true)
  expect(isFetchableUrl('https://sub.example.com/page?x=1').ok).toBe(true)
})

test('KNOWN RESIDUAL RISK: a DNS-rebinding hostname is not caught by string inspection alone', () => {
  // "127.0.0.1.nip.io" is a real, letter-containing public hostname whose
  // A-record happens to resolve to 127.0.0.1 — isFetchableUrl cannot see
  // that without doing DNS resolution (not feasible pre-connect here), so
  // it passes. This test documents the residual gap rather than asserting
  // it is closed; see the KNOWN RESIDUAL RISK comment on isFetchableUrl.
  expect(isFetchableUrl('http://127.0.0.1.nip.io/').ok).toBe(true)
})

// --- S3: redirect re-validation --------------------------------------------

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('fetchReadable refuses a response whose final (redirected) URL is blocked, and discards the body', async () => {
  const textSpy = vi.fn(async () => '<html><body>secret metadata</body></html>')
  globalThis.fetch = vi.fn(async () =>
    ({
      ok: true,
      url: 'http://169.254.169.254/latest/meta-data/',
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: textSpy,
      body: null,
    }) as unknown as Response,
  )
  const result = await fetchReadable('https://example.com/redirects-away')
  expect('error' in result).toBe(true)
  if ('error' in result) expect(result.error).toMatch(/redirected to a blocked target/)
  // The body must never be read/returned once the final host is blocked.
  expect(textSpy).not.toHaveBeenCalled()
})

test('fetchReadable still succeeds when the final URL stays public', async () => {
  globalThis.fetch = vi.fn(async () =>
    ({
      ok: true,
      url: 'https://example.com/final',
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => '<html><head><title>T</title></head><body><main><p>Hello.</p></main></body></html>',
      body: null,
    }) as unknown as Response,
  )
  const result = await fetchReadable('https://example.com/start')
  expect('error' in result).toBe(false)
  if (!('error' in result)) expect(result.text).toContain('Hello.')
})
