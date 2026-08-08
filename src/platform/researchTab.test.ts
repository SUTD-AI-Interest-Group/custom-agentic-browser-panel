import { test, expect, vi, afterEach } from 'vitest'
import { navigateAndWait } from './researchTab'

// C3: navigateAndWait must re-validate WHERE the tab actually landed, not just
// where it was told to go — Chrome follows an HTTP redirect transparently and
// there is no webNavigation/webRequest permission to intercept it, so a url
// that passes isFetchableUrl pre-navigation can still land on a blocked
// target (link-local metadata, a LAN admin panel, localhost, …).

/** A fake chrome.tabs that "loads" instantly and reports `landedUrl` as the
 *  tab's live url — standing in for whatever the tab ends up on, independent
 *  of the url navigateAndWait was asked to go to (i.e. a redirect). */
function fakeChrome(landedUrl: string) {
  return {
    tabs: {
      update: vi.fn(async () => ({})),
      get: vi.fn(async (tabId: number) => ({ id: tabId, status: 'complete', url: landedUrl })),
      onUpdated: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('navigateAndWait refuses when the requested url itself is where the tab lands (no redirect needed to trip the guard)', async () => {
  vi.stubGlobal('chrome', fakeChrome('http://169.254.169.254/latest/meta-data/'))
  const out = await navigateAndWait(101, 'http://169.254.169.254/latest/meta-data/')
  expect(out.blockedReason).toBeTruthy()
  expect(out.url).toBe('http://169.254.169.254/latest/meta-data/')
})

test('navigateAndWait refuses when a public REQUESTED url redirects to a blocked LANDED url', async () => {
  vi.stubGlobal('chrome', fakeChrome('http://169.254.169.254/latest/meta-data/'))
  // The requested url is a normal public address — only the tab's actual,
  // post-redirect landing (simulated by the fake's fixed `get` response) is
  // blocked. This is the exact shape of the bug: a public link that 302s
  // straight into cloud metadata / RFC1918 / loopback.
  const out = await navigateAndWait(101, 'https://example.com/redirects-away')
  expect(out.blockedReason).toBeTruthy()
  expect(out.url).toBe('http://169.254.169.254/latest/meta-data/')
})

test('navigateAndWait succeeds (no blockedReason) when the landed url stays public', async () => {
  vi.stubGlobal('chrome', fakeChrome('https://example.com/final'))
  const out = await navigateAndWait(101, 'https://example.com/start')
  expect(out.blockedReason).toBeUndefined()
  expect(out.url).toBe('https://example.com/final')
})
