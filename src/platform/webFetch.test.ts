import { test, expect } from 'vitest'
import { parseJsonLoose, isFetchableUrl, parseDuckDuckGoLite, extractReadableText } from './webFetch'

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
