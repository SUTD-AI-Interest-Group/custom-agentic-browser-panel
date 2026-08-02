import { test, expect } from 'vitest'
import { parseOpenGraph } from './linkPreview'

// parseOpenGraph is pure (no network), so these exercise the SSRF gap
// directly: a hostile page's own HTML declares an og:image pointing at an
// internal target, and — before the fix — that URL was only ever resolved
// against baseUrl, never screened, so it rendered straight into <img src> in
// the privileged panel with no click and no approval card.

test('extracts a normal public og:image untouched', () => {
  const html = '<meta property="og:image" content="https://cdn.example.com/thumb.png">'
  const preview = parseOpenGraph(html, 'https://example.com/article')
  expect(preview?.image).toBe('https://cdn.example.com/thumb.png')
})

test('resolves a relative og:image against baseUrl when it is safe', () => {
  const html = '<meta property="og:image" content="/thumb.png">'
  const preview = parseOpenGraph(html, 'https://example.com/article')
  expect(preview?.image).toBe('https://example.com/thumb.png')
})

test('drops an og:image pointing at a loopback/private target instead of rendering it', () => {
  const html = '<meta property="og:image" content="http://127.0.0.1/evil.png">'
  const preview = parseOpenGraph(html, 'https://example.com/article')
  expect(preview?.image).toBeUndefined()
})

test('drops an og:image pointing at a cloud metadata host', () => {
  const html = '<meta property="og:image" content="http://169.254.169.254/latest/meta-data/">'
  const preview = parseOpenGraph(html, 'https://example.com/article')
  expect(preview?.image).toBeUndefined()
})

test('drops a RELATIVE og:image that resolves (against baseUrl) to a private target', () => {
  // baseUrl itself can be an attacker-controlled host once BrowseSite/FetchUrl
  // et al. permit fetching arbitrary user-supplied URLs — a relative image
  // path must be screened AFTER resolution, not skipped just because it
  // looked relative in the source HTML.
  const html = '<meta property="og:image" content="/evil.png">'
  const preview = parseOpenGraph(html, 'http://192.168.1.1/article')
  expect(preview?.image).toBeUndefined()
})

test('drops an og:image using a non-standard IPv4 encoding (decimal integer host)', () => {
  const html = '<meta property="og:image" content="http://2130706433/evil.png">'
  const preview = parseOpenGraph(html, 'https://example.com/article')
  expect(preview?.image).toBeUndefined()
})

test('still returns title/description/siteName when only the image is unsafe — drops the image alone, not the whole preview', () => {
  const html = `
    <title>Fallback title</title>
    <meta property="og:description" content="A safe description.">
    <meta property="og:site_name" content="Example">
    <meta property="og:image" content="http://127.0.0.1/evil.png">
  `
  const preview = parseOpenGraph(html, 'https://example.com/article')
  expect(preview).not.toBeNull()
  expect(preview?.description).toBe('A safe description.')
  expect(preview?.siteName).toBe('Example')
  expect(preview?.image).toBeUndefined()
})

test('falls back to og:image:url and screens it the same way', () => {
  const safe = parseOpenGraph('<meta property="og:image:url" content="https://cdn.example.com/x.png">', 'https://example.com')
  expect(safe?.image).toBe('https://cdn.example.com/x.png')
  const unsafe = parseOpenGraph('<meta property="og:image:url" content="http://10.0.0.5/x.png">', 'https://example.com')
  expect(unsafe?.image).toBeUndefined()
})

test('returns null when nothing useful remains (no title/description/siteName and the only image was unsafe)', () => {
  const html = '<meta property="og:image" content="http://127.0.0.1/evil.png">'
  const preview = parseOpenGraph(html, 'https://example.com/article')
  expect(preview).toBeNull()
})
