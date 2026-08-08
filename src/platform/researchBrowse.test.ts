import { test, expect, vi, afterEach } from 'vitest'
import { handleBrowseOp } from './researchBrowse'
import { acquireTab } from './researchTab'

// A single fake chrome covering exactly what open→(tab dies)→read touches:
// window/tab creation, navigation-complete polling, and the two
// chrome.scripting.executeScript calls snapshotPage/readReadableText make.
// `kill()` flips every one of those into Chrome's real "the tab is gone"
// error shape, standing in for the tab/window disappearing mid-session (SW
// eviction, the user closing the minimized research window, a crash).
function fakeChrome() {
  let dead = false
  const genericPageResult = {
    elements: [],
    truncated: false,
    url: 'https://example.com/',
    title: 'Example',
    origin: 'https://example.com',
    dpr: 1,
    text: 'hello world',
    gist: 'hello world',
  }
  const missingTabError = () => new Error('No tab with id: 101.')
  const chrome = {
    windows: {
      create: vi.fn(async () => ({ id: 1, tabs: [{ id: 101 }] })),
      get: vi.fn(async () => ({ id: 1 })),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}),
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        if (dead) throw missingTabError()
        return { id: tabId, status: 'complete', url: 'https://example.com/' }
      }),
      update: vi.fn(async (tabId: number, props: Record<string, unknown>) => ({ id: tabId, ...props })),
      onUpdated: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      goBack: vi.fn(async () => {}),
    },
    scripting: {
      executeScript: vi.fn(async () => {
        if (dead) throw missingTabError()
        return [{ result: genericPageResult }]
      }),
    },
    storage: {
      session: {
        set: vi.fn(async () => {}),
        get: vi.fn(async () => ({})),
        remove: vi.fn(async () => {}),
      },
    },
  }
  return { chrome, kill: () => { dead = true } }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('a dead underlying tab releases its browse session AND the shared research-tab lease, instead of stalling until the TTL', async () => {
  const fake = fakeChrome()
  vi.stubGlobal('chrome', fake.chrome)

  const sessionId = 'task-1:browse:0'
  const opened = await handleBrowseOp(sessionId, { kind: 'open', url: 'https://example.com/' })
  expect(opened.ok).toBe(true)

  // The tab/window disappears (eviction, user closed the minimized window, a
  // crash) — the next round-trip's executeScript call rejects like Chrome does
  // for a missing tab.
  fake.kill()
  const failed = await handleBrowseOp(sessionId, { kind: 'read' })
  expect(failed.ok).toBe(false)

  // (a) The session itself must be gone, not merely reporting an error — a
  // second call for the SAME sessionId only produces this message once
  // handleBrowseOp's catch has actually called closeSession(). Before the fix,
  // the session lingers in the map and this assertion fails (readSession still
  // finds it and tries — and fails — to read the dead tab again).
  const afterClose = await handleBrowseOp(sessionId, { kind: 'read' })
  expect(afterClose.message).toBe('no open browse session — call open first')

  // (b) The shared, singleton research-tab lease must have been released too
  // — a DIFFERENT consumer's acquireTab() must not be stuck behind it. Before
  // the fix, session.lease.release() is never called, so the promise chain
  // inside researchTab.ts never unlocks and this acquireTab() call hangs for
  // the full 4-minute SESSION_TTL_MS; racing it against a short timer proves
  // it resolved promptly rather than actually waiting out the race.
  let otherLease: { tabId: number; release(): void } | undefined
  const outcome = await Promise.race([
    acquireTab().then((lease) => {
      otherLease = lease
      return 'resolved' as const
    }),
    new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
  ])
  expect(outcome).toBe('resolved')
  otherLease?.release()
})

// --- C3 / TOCTOU: redirect re-validation mid-browse-session -----------------
// A url that passes the pre-navigation policy (isSafeResearchAction, which only
// ever sees the REQUESTED target) can still redirect the tab somewhere blocked
// — link-local metadata, a LAN admin panel, localhost. And a separate "check
// the tab's url, THEN separately read its content" step (even navigateAndWait's
// own landed-url check, which happens BEFORE observe() runs) is inherently
// racy — page JS can redirect the tab in the gap. observe() closes that by
// validating the url returned BY snapshotPage/readReadableText themselves
// (captured atomically with their content), so these tests model each of the
// THREE distinct stages a redirect could land in: navigateAndWait's own fast
// check, snapshotPage's injection, and readReadableText's injection — each
// independently, to prove there's no gap left between any of them.
//
// Every test uses a fresh module instance (vi.resetModules + dynamic import)
// so a per-test staged url can't be confused by another test's leftover
// session/lease state in researchTab.ts's module-scope singleton.

/**
 * Models three independently-controllable "moments" a redirect could land in:
 *  - navUrl: what navigateAndWait's own two chrome.tabs.get calls see (its
 *    fast-path check, run BEFORE observe() ever starts).
 *  - snapshotUrl: what snapshotPage's injected function (domIndex.ts's
 *    buildInteractiveIndex) captures as `location.href`, atomically with the
 *    elements it harvests. Defaults to navUrl.
 *  - readUrl: what readReadableText's injected function (injExtractReadable)
 *    captures as `location.href`, atomically with the text. Defaults to
 *    snapshotUrl.
 * Distinguishes the two injected-function call sites by `params.func.name`
 * (chrome.scripting.executeScript is invoked with `{target, func, args}`),
 * since both funnel through one `chrome.scripting.executeScript` mock but
 * must return different shapes/urls to model a redirect that fires strictly
 * BETWEEN them.
 */
function fakeChromeStaged(opts: { navUrl: string; snapshotUrl?: string; readUrl?: string; text?: string }) {
  const snapshotUrl = opts.snapshotUrl ?? opts.navUrl
  const readUrl = opts.readUrl ?? snapshotUrl
  return {
    windows: {
      create: vi.fn(async () => ({ id: 1, tabs: [{ id: 101 }] })),
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, status: 'complete', url: opts.navUrl })),
      update: vi.fn(async (tabId: number, props: Record<string, unknown>) => ({ id: tabId, ...props })),
      onUpdated: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      goBack: vi.fn(async () => {}),
    },
    scripting: {
      executeScript: vi.fn(async (params: { func: (...a: any[]) => any }) => {
        if (params.func.name === 'injExtractReadable') {
          return [{ result: { title: 'T', text: opts.text ?? 'hello world', url: readUrl } }]
        }
        // Everything else funnelled through executeScript (snapshotPage's
        // buildInteractiveIndex, waitForStable's injWaitStable, dispatch's
        // inj* action functions) — a page-snapshot-shaped result covers what
        // each of those actually reads off the return value.
        return [
          {
            result: {
              elements: [],
              truncated: false,
              url: snapshotUrl,
              title: 'Example',
              origin: 'https://example.com',
              dpr: 1,
              text: 'hello world',
              gist: 'hello world',
              ok: true,
              reason: 'quiet',
              message: 'ok',
            },
          },
        ]
      }),
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

test('openSession refuses a blocked INPUT url before ever touching a tab', async () => {
  vi.resetModules()
  const chrome = fakeChromeStaged({ navUrl: 'http://169.254.169.254/' })
  vi.stubGlobal('chrome', chrome)
  const { handleBrowseOp: freshHandleBrowseOp } = await import('./researchBrowse')

  const result = await freshHandleBrowseOp('c3-input:browse:0', {
    kind: 'open',
    url: 'http://169.254.169.254/latest/meta-data/',
  })
  expect(result.ok).toBe(false)
  expect(chrome.windows.create).not.toHaveBeenCalled()
})

test('openSession refuses when navigateAndWait itself lands on a blocked target (fast path)', async () => {
  vi.resetModules()
  const chrome = fakeChromeStaged({ navUrl: 'http://169.254.169.254/latest/meta-data/' })
  vi.stubGlobal('chrome', chrome)
  const { handleBrowseOp: freshHandleBrowseOp } = await import('./researchBrowse')

  const result = await freshHandleBrowseOp('c3-redirect:browse:0', {
    kind: 'open',
    url: 'https://example.com/redirects-away',
  })
  expect(result.ok).toBe(false)
  expect(result.message).toMatch(/redirected to a blocked target/)
  expect(result.observation).toBeUndefined()
  // The fast path catches this before observe() ever runs.
  expect(chrome.scripting.executeScript).not.toHaveBeenCalled()
})

test('TOCTOU: openSession refuses when the page redirects AFTER navigateAndWait already passed, before snapshotPage runs', async () => {
  vi.resetModules()
  // navigateAndWait's own check sees a SAFE url — the redirect fires in the
  // gap between that check and observe()'s first injection (snapshotPage).
  // A separate chrome.tabs.get sampled here (the old design) would have
  // missed this; observe() validates snapshotPage's OWN captured url instead.
  const chrome = fakeChromeStaged({
    navUrl: 'https://example.com/final',
    snapshotUrl: 'http://169.254.169.254/latest/meta-data/',
  })
  vi.stubGlobal('chrome', chrome)
  const { handleBrowseOp: freshHandleBrowseOp } = await import('./researchBrowse')

  const result = await freshHandleBrowseOp('c3-toctou-snap:browse:0', { kind: 'open', url: 'https://example.com/start' })
  expect(result.ok).toBe(false)
  expect(result.message).toMatch(/blocked target/)
  expect(result.observation).toBeUndefined()
})

test('TOCTOU: openSession refuses when the page redirects again BETWEEN snapshotPage and readReadableText', async () => {
  vi.resetModules()
  // Both navigateAndWait's check and snapshotPage's own atomic url are safe —
  // the redirect fires in the necessarily-separate gap before the second
  // injection, readReadableText. observe() catches this on its own atomic
  // url, discarding the (now-stale-but-technically-safe) elements too.
  const chrome = fakeChromeStaged({
    navUrl: 'https://example.com/final',
    snapshotUrl: 'https://example.com/final',
    readUrl: 'http://169.254.169.254/latest/meta-data/',
    text: 'secret metadata',
  })
  vi.stubGlobal('chrome', chrome)
  const { handleBrowseOp: freshHandleBrowseOp } = await import('./researchBrowse')

  const result = await freshHandleBrowseOp('c3-toctou-read:browse:0', { kind: 'open', url: 'https://example.com/start' })
  expect(result.ok).toBe(false)
  expect(result.message).toMatch(/blocked target/)
  expect(result.observation).toBeUndefined()
})

test('openSession still succeeds when every stage stays public (no false positive)', async () => {
  vi.resetModules()
  const chrome = fakeChromeStaged({ navUrl: 'https://example.com/final' })
  vi.stubGlobal('chrome', chrome)
  const { handleBrowseOp: freshHandleBrowseOp } = await import('./researchBrowse')

  const result = await freshHandleBrowseOp('c3-ok:browse:0', { kind: 'open', url: 'https://example.com/start' })
  expect(result.ok).toBe(true)
  expect(result.observation?.url).toBe('https://example.com/final')
})

test('mixed-provenance: openSession refuses when the page bounces between two DIFFERENT, both-safe urls between snapshotPage and readReadableText', async () => {
  vi.resetModules()
  // Neither url is ever blocked — isFetchableUrl passes for both individually
  // — so this is NOT the redirect-to-blocked-target bug above. It is the
  // narrower correctness bug: elements captured from page-a, text captured
  // from page-b (a different, later round trip), returned as one observation
  // under a single url. Nothing here can leak blocked content; it can return
  // a report that cites the wrong page.
  const chrome = fakeChromeStaged({
    navUrl: 'https://example.com/page-a',
    snapshotUrl: 'https://example.com/page-a',
    readUrl: 'https://example.com/page-b',
    text: 'text from page B',
  })
  vi.stubGlobal('chrome', chrome)
  const { handleBrowseOp: freshHandleBrowseOp } = await import('./researchBrowse')

  const result = await freshHandleBrowseOp('c3-mixed:browse:0', { kind: 'open', url: 'https://example.com/start' })
  expect(result.ok).toBe(false)
  expect(result.message).toMatch(/moved/)
  expect(result.observation).toBeUndefined()
})

test('an explicit `navigate` action that redirects to a blocked target is refused via the atomic observe() check, and the session survives to try something else', async () => {
  vi.resetModules()
  const chrome = fakeChromeStaged({ navUrl: 'https://example.com/start' })
  vi.stubGlobal('chrome', chrome)
  const { handleBrowseOp: freshHandleBrowseOp } = await import('./researchBrowse')

  const sessionId = 'c3-navigate:browse:0'
  const opened = await freshHandleBrowseOp(sessionId, { kind: 'open', url: 'https://example.com/start' })
  expect(opened.ok).toBe(true)

  // pageActions.ts's navigateTab (chrome.tabs.update) does not wait for/
  // re-validate where the tab ends up — the redirect must be caught by
  // observe()'s atomic checks after dispatch, not by sampling chrome.tabs.get
  // separately (the old, still-racy design).
  chrome.scripting.executeScript = vi.fn(async (params: { func: (...a: any[]) => any }) => {
    if (params.func.name === 'injExtractReadable') {
      return [{ result: { title: 'T', text: 'secret metadata', url: 'http://169.254.169.254/latest/meta-data/' } }]
    }
    return [
      {
        result: {
          elements: [],
          truncated: false,
          url: 'http://169.254.169.254/latest/meta-data/',
          title: 'Example',
          origin: 'http://169.254.169.254',
          dpr: 1,
          text: 'hello world',
          gist: 'hello world',
          ok: true,
          reason: 'quiet',
          message: 'ok',
        },
      },
    ]
  })

  const acted = await freshHandleBrowseOp(sessionId, {
    kind: 'act',
    action: { kind: 'navigate', url: 'https://example.com/redirects-away' },
  })
  expect(acted.ok).toBe(false)
  expect(acted.message).toMatch(/blocked target/)
  expect(acted.observation).toBeUndefined()

  // The session itself is NOT torn down by a blocked landing — the model can
  // still call `read`/`act`/`close` on it — but reading is refused too, since
  // the tab is still sitting on the blocked page.
  const read = await freshHandleBrowseOp(sessionId, { kind: 'read' })
  expect(read.ok).toBe(false)
  expect(read.message).toMatch(/blocked target/)
})
