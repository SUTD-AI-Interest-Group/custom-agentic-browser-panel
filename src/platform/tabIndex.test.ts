import { describe, it, expect, test, vi, afterEach } from 'vitest'
import {
  clampGist,
  findDuplicates,
  hostOf,
  isBlankUrl,
  isProbeableUrl,
  listTabFacts,
  normalizeUrl,
  planTabProbe,
  GIST_CHARS,
} from './tabIndex'

describe('isProbeableUrl', () => {
  it('accepts ordinary http(s) pages', () => {
    expect(isProbeableUrl('https://example.com/docs')).toBe(true)
    expect(isProbeableUrl('http://localhost:5173/')).toBe(true)
  })

  it('rejects browser-internal and unscriptable schemes', () => {
    for (const url of [
      'chrome://extensions',
      'chrome://newtab',
      'edge://settings',
      'about:blank',
      'devtools://devtools/bundled/inspector.html',
      'view-source:https://example.com',
      'file:///Users/x/notes.txt',
      'chrome-extension://abc/sidepanel.html',
      'data:text/html,hi',
    ]) {
      expect(isProbeableUrl(url), url).toBe(false)
    }
  })

  it('accepts a local file once file-scheme access is granted', () => {
    expect(isProbeableUrl('file:///Users/x/notes.txt', { fileAccess: true })).toBe(true)
    // Still rejects the schemes no toggle reaches.
    expect(isProbeableUrl('chrome://extensions', { fileAccess: true })).toBe(false)
    // And exotic schemes stay out whatever the toggle says.
    expect(isProbeableUrl('ftp://files.test/a.txt', { fileAccess: true })).toBe(false)
  })

  it('rejects the Chrome Web Store, which blocks injection', () => {
    expect(isProbeableUrl('https://chromewebstore.google.com/detail/abc')).toBe(false)
    expect(isProbeableUrl('https://chrome.google.com/webstore/category/extensions')).toBe(false)
    // A different path on the same host is ordinary and fine.
    expect(isProbeableUrl('https://chrome.google.com/')).toBe(true)
  })

  it('rejects garbage rather than throwing', () => {
    expect(isProbeableUrl('not a url')).toBe(false)
    expect(isProbeableUrl('')).toBe(false)
  })
})

describe('isBlankUrl', () => {
  it('recognizes the new-tab and blank pages', () => {
    expect(isBlankUrl('about:blank')).toBe(true)
    expect(isBlankUrl('chrome://newtab/')).toBe(true)
    expect(isBlankUrl('chrome://new-tab-page')).toBe(true)
    expect(isBlankUrl('')).toBe(true)
    expect(isBlankUrl('https://example.com')).toBe(false)
  })
})

describe('planTabProbe', () => {
  it('never probes a discarded tab, however ordinary its URL', () => {
    // The expensive mistake this whole function exists to prevent: waking a
    // sleeping tab costs a page load and the RAM Chrome just reclaimed.
    const plan = planTabProbe([
      { tabId: 1, url: 'https://example.com/a', discarded: true },
      { tabId: 2, url: 'https://example.com/b', discarded: false },
    ])
    expect(plan.probe).toEqual([2])
    expect(plan.skip).toEqual([
      { tabId: 1, reason: expect.stringContaining('asleep') },
    ])
  })

  it('skips blank and browser-internal tabs with distinct reasons', () => {
    const plan = planTabProbe([
      { tabId: 1, url: 'about:blank', discarded: false },
      { tabId: 2, url: 'chrome://extensions', discarded: false },
      { tabId: 3, url: 'https://example.com', discarded: false },
    ])
    expect(plan.probe).toEqual([3])
    expect(plan.skip[0].reason).toContain('Blank tab')
    expect(plan.skip[1].reason).toContain('browser-internal page')
  })

  it('probes local files only once the user has granted file access', () => {
    const tabs = [{ tabId: 1, url: 'file:///Users/x/quiz.html', discarded: false }]
    expect(planTabProbe(tabs).probe).toEqual([])
    expect(planTabProbe(tabs, 100, { fileAccess: false }).probe).toEqual([])
    expect(planTabProbe(tabs, 100, { fileAccess: true }).probe).toEqual([1])
  })

  it('tells the user how to unlock a local file instead of calling it internal', () => {
    // The distinction is the point: one of these the user can fix in ten
    // seconds, the other is closed forever.
    const [skip] = planTabProbe(
      [{ tabId: 1, url: 'file:///Users/x/quiz.html', discarded: false }],
      100,
      { fileAccess: false },
    ).skip
    expect(skip.reason).toContain('Allow access to file URLs')
    expect(skip.reason).not.toContain('browser-internal')
  })

  it('stops probing past the limit but still lists the overflow', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      tabId: i + 1,
      url: `https://example.com/${i}`,
      discarded: false,
    }))
    const plan = planTabProbe(many, 3)
    expect(plan.probe).toEqual([1, 2, 3])
    expect(plan.limitHit).toBe(true)
    expect(plan.skip.map((s) => s.tabId)).toEqual([4, 5])
    expect(plan.skip[0].reason).toContain('3-tab read limit')
  })

  it('does not report a limit hit when everything fits', () => {
    const plan = planTabProbe([{ tabId: 1, url: 'https://example.com', discarded: false }], 3)
    expect(plan.limitHit).toBe(false)
  })
})

describe('clampGist', () => {
  it('collapses whitespace and leaves short text alone', () => {
    expect(clampGist('  Pricing   and\n plans ')).toBe('Pricing and plans')
  })

  it('clamps to the budget and breaks on a word boundary', () => {
    const out = clampGist(`${'word '.repeat(100)}`, 40)
    expect(out.length).toBeLessThanOrEqual(41) // budget + the ellipsis
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toContain('wor…') // not a severed word
  })

  it('still clamps when there is no usable word boundary', () => {
    const out = clampGist('x'.repeat(500), 40)
    expect(out).toHaveLength(41)
    expect(out.endsWith('…')).toBe(true)
  })

  it('defaults to the shared gist budget', () => {
    expect(clampGist('y'.repeat(500))).toHaveLength(GIST_CHARS + 1)
  })
})

describe('normalizeUrl', () => {
  it('ignores scheme, www, fragment and trailing slash', () => {
    const a = normalizeUrl('https://www.example.com/docs/')
    expect(normalizeUrl('http://example.com/docs')).toBe(a)
    expect(normalizeUrl('https://example.com/docs#section-2')).toBe(a)
  })

  it('strips tracking parameters but keeps meaningful query', () => {
    expect(normalizeUrl('https://example.com/p?utm_source=x&id=7&fbclid=abc')).toBe('example.com/p?id=7')
  })

  it('sorts query parameters so order does not create a false difference', () => {
    expect(normalizeUrl('https://example.com/p?b=2&a=1')).toBe(normalizeUrl('https://example.com/p?a=1&b=2'))
  })

  it('keeps genuinely different pages apart', () => {
    expect(normalizeUrl('https://example.com/a')).not.toBe(normalizeUrl('https://example.com/b'))
    expect(normalizeUrl('https://example.com/p?id=1')).not.toBe(normalizeUrl('https://example.com/p?id=2'))
  })
})

describe('hostOf', () => {
  it('returns the host for an ordinary URL, including a port', () => {
    expect(hostOf('https://example.com:8080/path')).toBe('example.com:8080')
  })

  it('ignores userinfo when extracting the host', () => {
    expect(hostOf('https://user:pass@example.com/path')).toBe('example.com')
  })

  it('falls back to a truncated string, not the whole raw URL, for a data: URL', () => {
    // The whole point of tabIndex's gist budget is a bounded cost per tab —
    // hostOf's odd-scheme fallback ("no .host, so return the raw url") used to
    // undo that entirely for any data:/javascript: tab.
    const huge = `data:text/html;base64,${'A'.repeat(500_000)}`
    const host = hostOf(huge)
    expect(host.length).toBeLessThan(600)
    expect(host.endsWith('…')).toBe(true)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test("listTabFacts caps a data: URL tab's url/host so one tab cannot blow up a ReadTabs call", async () => {
  const huge = `data:text/html;base64,${'A'.repeat(500_000)}`
  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => [
        { id: 1, windowId: 1, title: 'Report', url: huge, pinned: false, active: true, groupId: -1 },
      ]),
    },
  })
  const facts = await listTabFacts()
  expect(facts).toHaveLength(1)
  expect(facts[0].url.length).toBeLessThan(600)
  expect(facts[0].host.length).toBeLessThan(600)
})

describe('findDuplicates', () => {
  it('clusters tabs on the same page despite tracking noise', () => {
    const dupes = findDuplicates([
      { tabId: 1, url: 'https://example.com/docs' },
      { tabId: 2, url: 'https://www.example.com/docs/?utm_source=newsletter' },
      { tabId: 3, url: 'https://example.com/other' },
    ])
    expect(dupes).toEqual([{ url: 'https://example.com/docs', tabIds: [1, 2] }])
  })

  it('returns nothing when every tab is distinct', () => {
    expect(
      findDuplicates([
        { tabId: 1, url: 'https://a.com' },
        { tabId: 2, url: 'https://b.com' },
      ]),
    ).toEqual([])
  })

  it('does not cluster blank tabs together', () => {
    // Five empty new-tab pages are not "five duplicates of a page".
    expect(
      findDuplicates([
        { tabId: 1, url: 'about:blank' },
        { tabId: 2, url: 'about:blank' },
        { tabId: 3, url: '' },
      ]),
    ).toEqual([])
  })
})
