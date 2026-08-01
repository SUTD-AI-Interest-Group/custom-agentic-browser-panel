import { test, expect } from 'vitest'
import { isSafeRenderUrl } from './safeRenderUrl'

// Table-driven over the same adversarial URL shapes webFetch.test.ts covers
// for isFetchableUrl, since isSafeRenderUrl delegates to it — this both locks
// down the delegation and documents the extra restrictions layered on top.

test('allows a normal public http(s) URL', () => {
  expect(isSafeRenderUrl('https://example.com/a.png')).toBe(true)
  expect(isSafeRenderUrl('http://example.com/a.png')).toBe(true)
})

test('rejects loopback/private/link-local hosts (delegated from isFetchableUrl)', () => {
  expect(isSafeRenderUrl('http://127.0.0.1/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://10.1.2.3/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://172.16.0.1/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://192.168.0.1/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://169.254.169.254/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://0.0.0.0/x.png')).toBe(false)
})

test('rejects non-standard IPv4 encodings (decimal/hex/octal integer hosts)', () => {
  expect(isSafeRenderUrl('http://2130706433/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://0x7f000001/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://0177.0.0.1/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://0x7f.0.0.1/x.png')).toBe(false)
})

test('rejects bracketed IPv6 literals outright (loopback, link-local, unique-local, IPv4-mapped)', () => {
  expect(isSafeRenderUrl('http://[::1]/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://[fe80::1]/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://[fd00::1]/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://[::ffff:127.0.0.1]/x.png')).toBe(false)
})

test('rejects known cloud metadata hostnames', () => {
  expect(isSafeRenderUrl('http://metadata.google.internal/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://metadata/x.png')).toBe(false)
})

test('rejects non-http(s) schemes', () => {
  expect(isSafeRenderUrl('file:///etc/passwd')).toBe(false)
  expect(isSafeRenderUrl('javascript:alert(1)')).toBe(false)
  expect(isSafeRenderUrl('data:image/png;base64,AAAA')).toBe(false)
})

test('rejects trailing-dot localhost/loopback bypasses', () => {
  expect(isSafeRenderUrl('http://localhost./x.png')).toBe(false)
  expect(isSafeRenderUrl('http://127.0.0.1../x.png')).toBe(false)
})

test('rejects the RFC 6598 CGNAT range on top of the shared guard (Alibaba Cloud metadata lives at 100.100.100.200)', () => {
  expect(isSafeRenderUrl('http://100.64.0.1/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://100.100.100.200/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://100.127.255.255/x.png')).toBe(false)
})

test('allows public 100.x addresses just outside the CGNAT range', () => {
  expect(isSafeRenderUrl('http://100.63.255.255/x.png')).toBe(true)
  expect(isSafeRenderUrl('http://100.128.0.1/x.png')).toBe(true)
})

test('rejects the *.localhost / .internal reserved conventions on top of the shared guard', () => {
  expect(isSafeRenderUrl('http://localhost/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://foo.localhost/x.png')).toBe(false)
  expect(isSafeRenderUrl('http://service.internal/x.png')).toBe(false)
})

test('rejects an invalid URL string rather than throwing', () => {
  expect(isSafeRenderUrl('not a url')).toBe(false)
})

test('still allows an ordinary public hostname with a path/query', () => {
  expect(isSafeRenderUrl('https://cdn.example.com/img/a.png?w=200')).toBe(true)
})
