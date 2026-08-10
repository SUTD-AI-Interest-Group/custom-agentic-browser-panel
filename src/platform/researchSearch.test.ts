import { test, expect, vi, afterEach } from 'vitest'
import { searchInTab } from './researchSearch'

// Item 4 of the adversarial review: searchInTab discarded navigateAndWait's
// return value entirely, so this call site got zero benefit from making
// NavigateOutcome meaningful. Not exploitable today (the destination is a
// fixed, hardcoded DuckDuckGo host — the query is the only attacker-
// influenced part), but a discarded return value here means a future edit
// could wrongly assume this call site is already guarded like the others.

function fakeChrome(landedUrl: string) {
  return {
    windows: {
      create: vi.fn(async () => ({ id: 1, tabs: [{ id: 101 }] })),
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, status: 'complete', url: landedUrl })),
      update: vi.fn(async (tabId: number, props: Record<string, unknown>) => ({ id: tabId, ...props })),
      onUpdated: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: { rows: [{ title: 'A', url: 'https://a.example/', snippet: '' }], challenged: false } }]),
    },
    // researchTab parks the leased window on the extension's own
    // research-tab.html, so the stub needs getURL like the real API has.
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
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

test('searchInTab refuses and never scrapes if the DDG tab somehow lands on a blocked target', async () => {
  const chrome = fakeChrome('http://169.254.169.254/latest/meta-data/')
  vi.stubGlobal('chrome', chrome)
  const out = await searchInTab('test query')
  expect(out.error).toMatch(/redirected to a blocked target/)
  expect(out.results).toBeUndefined()
  expect(chrome.scripting.executeScript).not.toHaveBeenCalled()
})

test('searchInTab still returns results for the normal DDG landing (no false positive)', async () => {
  const chrome = fakeChrome('https://html.duckduckgo.com/html/')
  vi.stubGlobal('chrome', chrome)
  const out = await searchInTab('test query')
  expect(out.error).toBeUndefined()
  expect(out.results).toHaveLength(1)
})
