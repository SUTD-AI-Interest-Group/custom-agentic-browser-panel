import { test, expect, vi, afterEach } from 'vitest'

// renderPage is the passive half of the research browser (navigate, settle,
// read, done). Two things must hold:
//  - a blocked/redirected-to-blocked url must never be scraped or exposed
//  - TOCTOU: the url validated must be the SAME one the content came from,
//    never one sampled earlier (before the scroll/settle window) or later —
//    a "check the url, then separately read the content" step is racy no
//    matter how short the gap.
//
// Each test uses a fresh module instance (vi.resetModules + dynamic import)
// so researchTab.ts's module-scope tab/window singleton state from one test
// can never leak into another (e.g. a reused renderTabId silently skipping
// windows.create and throwing off the chrome.tabs.get call-count modeling below).

interface FakeOpts {
  /** What navigateAndWait's own landed-url check sees (its two chrome.tabs.get calls). */
  navigatedUrl: string
  /** What the injected extraction function reports as `location.href`,
   *  captured ATOMICALLY with the content. Defaults to navigatedUrl; set it
   *  differently to model a redirect firing DURING the scroll/settle window,
   *  after navigateAndWait's own check already passed — the actual bug. */
  extractedUrl?: string
  pageText?: string
}

function fakeChrome(opts: FakeOpts) {
  const extractedUrl = opts.extractedUrl ?? opts.navigatedUrl
  return {
    windows: {
      create: vi.fn(async () => ({ id: 1, tabs: [{ id: 101 }] })),
      update: vi.fn(async () => ({})),
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        return { id: tabId, status: 'complete', url: opts.navigatedUrl }
      }),
      update: vi.fn(async (tabId: number, props: Record<string, unknown>) => ({ id: tabId, ...props })),
      onUpdated: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    scripting: {
      executeScript: vi.fn(async () => [
        { result: { title: 'T', text: opts.pageText ?? 'hello world', url: extractedUrl } },
      ]),
    },
    storage: {
      session: {
        set: vi.fn(async () => {}),
        get: vi.fn(async () => ({})),
        remove: vi.fn(async () => {}),
      },
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('renderPage refuses a blocked input URL without ever opening a tab', async () => {
  vi.resetModules()
  const chrome = fakeChrome({ navigatedUrl: 'http://169.254.169.254/' })
  vi.stubGlobal('chrome', chrome)
  const { renderPage } = await import('./researchRender')
  const out = await renderPage('http://169.254.169.254/latest/meta-data/')
  expect(out.error).toMatch(/refused to render/)
  expect(chrome.windows.create).not.toHaveBeenCalled()
})

test('renderPage refuses when navigateAndWait itself lands on a blocked target (fast path)', async () => {
  vi.resetModules()
  const chrome = fakeChrome({ navigatedUrl: 'http://169.254.169.254/latest/meta-data/', pageText: 'secret metadata' })
  vi.stubGlobal('chrome', chrome)
  const { renderPage } = await import('./researchRender')
  const out = await renderPage('https://example.com/redirects-away')
  expect(out.error).toMatch(/redirected to a blocked target/)
  expect(out.text).toBeUndefined()
  // The fast path catches this before ever scraping.
  expect(chrome.scripting.executeScript).not.toHaveBeenCalled()
})

test('TOCTOU: renderPage refuses when the page redirects DURING the scroll/settle window, after navigateAndWait already passed', async () => {
  vi.resetModules()
  // navigateAndWait's own check sees a SAFE url (the redirect has not fired
  // yet) — this models the exact bug the review found: a delayed
  // `location.href = ...` firing from a `setTimeout` inside the 900ms
  // scroll/sleep window, between the navigation-complete check and the
  // content read. Only the ATOMIC extraction (extractedUrl) sees the truth.
  const chrome = fakeChrome({
    navigatedUrl: 'https://example.com/final',
    extractedUrl: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    pageText: 'secret metadata',
  })
  vi.stubGlobal('chrome', chrome)
  const { renderPage } = await import('./researchRender')
  const out = await renderPage('https://example.com/start')
  expect(out.error).toMatch(/redirected to a blocked target/)
  expect(out.text).toBeUndefined()
  // The mislabeling half of the bug: a blocked read must never be reported
  // under the earlier, now-stale "safe" url.
  expect(out.finalUrl).toBeUndefined()
})

test('renderPage reports finalUrl from the atomic content read, not the earlier navigateAndWait check', async () => {
  vi.resetModules()
  const chrome = fakeChrome({
    navigatedUrl: 'https://example.com/intermediate',
    extractedUrl: 'https://example.com/truly-final',
    pageText: 'Hello, world.',
  })
  vi.stubGlobal('chrome', chrome)
  const { renderPage } = await import('./researchRender')
  const out = await renderPage('https://example.com/start')
  expect(out.error).toBeUndefined()
  expect(out.text).toBe('Hello, world.')
  // Proves finalUrl comes from the atomic read, not the (different) earlier check.
  expect(out.finalUrl).toBe('https://example.com/truly-final')
})

test('renderPage still succeeds for a normal URL that stays public (no false positive)', async () => {
  vi.resetModules()
  const chrome = fakeChrome({ navigatedUrl: 'https://example.com/final', pageText: 'Hello, world.' })
  vi.stubGlobal('chrome', chrome)
  const { renderPage } = await import('./researchRender')
  const out = await renderPage('https://example.com/start')
  expect(out.error).toBeUndefined()
  expect(out.text).toBe('Hello, world.')
  expect(out.finalUrl).toBe('https://example.com/final')
})
