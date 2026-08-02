import { afterEach, describe, expect, it, vi } from 'vitest'
import { faviconUrl } from './favicon'

// faviconUrl takes a page-derived, untrusted URL (any tab/link/citation the
// model or a page has ever pointed at, including whatever scheme an attacker
// picks) and must never let it influence anything but a single, safely
// percent-encoded query-string VALUE on the extension's own fixed
// chrome-extension://…/_favicon/ endpoint — never the scheme, origin, path,
// or any other query parameter of the URL actually used as an <img src>.

function fakeChrome() {
  return {
    runtime: {
      getURL: (path: string) => `chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef${path}`,
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('faviconUrl', () => {
  it('builds a URL on the extension\'s own _favicon/ endpoint with pageUrl/size as query params', () => {
    vi.stubGlobal('chrome', fakeChrome())
    const out = faviconUrl('https://example.com/page', 16)
    const u = new URL(out)
    expect(u.protocol).toBe('chrome-extension:')
    expect(u.pathname).toBe('/_favicon/')
    expect(u.searchParams.get('pageUrl')).toBe('https://example.com/page')
    expect(u.searchParams.get('size')).toBe('16')
  })

  it('defaults size to 32', () => {
    vi.stubGlobal('chrome', fakeChrome())
    const u = new URL(faviconUrl('https://example.com'))
    expect(u.searchParams.get('size')).toBe('32')
  })

  it('a javascript: pageUrl never reaches the scheme of the returned string — it is confined to an encoded query value', () => {
    vi.stubGlobal('chrome', fakeChrome())
    const out = faviconUrl('javascript:alert(1)')
    // The returned string itself must still be the extension's own href.
    expect(out.startsWith('chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/_favicon/')).toBe(true)
    const u = new URL(out)
    expect(u.protocol).toBe('chrome-extension:')
    // The payload survives only as the (inert) pageUrl query value.
    expect(u.searchParams.get('pageUrl')).toBe('javascript:alert(1)')
  })

  it('a data: pageUrl is likewise confined to the query value, never the returned href\'s own scheme', () => {
    vi.stubGlobal('chrome', fakeChrome())
    const payload = 'data:text/html,<script>alert(1)</script>'
    const out = faviconUrl(payload)
    expect(out.startsWith('chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/_favicon/')).toBe(true)
    const u = new URL(out)
    expect(u.protocol).toBe('chrome-extension:')
    expect(u.searchParams.get('pageUrl')).toBe(payload)
  })

  it('a pageUrl containing its own query-string syntax cannot inject a second query parameter or override size', () => {
    vi.stubGlobal('chrome', fakeChrome())
    const payload = 'https://example.com/x?evil=1&size=999#frag'
    const out = faviconUrl(payload, 48)
    const u = new URL(out)
    // Exactly the two params this function ever sets — nothing injected.
    expect([...u.searchParams.keys()].sort()).toEqual(['pageUrl', 'size'])
    expect(u.searchParams.get('size')).toBe('48')
    expect(u.searchParams.get('pageUrl')).toBe(payload)
  })

  it('an empty pageUrl still produces a well-formed URL on the same endpoint', () => {
    vi.stubGlobal('chrome', fakeChrome())
    const u = new URL(faviconUrl(''))
    expect(u.pathname).toBe('/_favicon/')
    expect(u.searchParams.get('pageUrl')).toBe('')
  })
})
