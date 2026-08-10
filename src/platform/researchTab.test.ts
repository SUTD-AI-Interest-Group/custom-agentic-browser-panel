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

// ---------------------------------------------------------------------------
// Window lifecycle.
//
// The bug these lock down: teardown used to be `setTimeout(teardown, 60_000)`
// in the MV3 service worker, which Chrome evicts after ~30s idle — and a
// released lease is followed by exactly the silence that triggers eviction,
// since the research heartbeat keeping the worker alive stops when the task
// ends. Measured in a real browser against the old algorithm, that timer fired
// ZERO times across three create/release cycles, so finished research left its
// minimized window open until some later cold boot happened to sweep it.
// ---------------------------------------------------------------------------

/** A fake chrome with the window/tab/session-storage/alarm surface the tab
 *  lifecycle touches. `session` deliberately outlives vi.resetModules(), which
 *  is how a service-worker eviction is simulated: module state is wiped, but
 *  chrome.storage.session is not. */
function fakeBrowser(opts: { tabsOnCreate?: boolean } = {}) {
  const session: Record<string, unknown> = {}
  const alarms: Record<string, unknown> = {}
  const open = new Set<number>()
  const removed: number[] = []
  let nextId = 100
  const asList = (keys: unknown) => (Array.isArray(keys) ? keys : [keys]) as string[]
  return {
    state: { session, alarms, open, removed, created: () => nextId },
    runtime: { getURL: (p: string) => `chrome-extension://fake/${p}` },
    windows: {
      create: vi.fn(async () => {
        const id = ++nextId
        const tabId = ++nextId
        open.add(id)
        return { id, tabs: opts.tabsOnCreate === false ? undefined : [{ id: tabId }] }
      }),
      remove: vi.fn(async (id: number) => {
        removed.push(id)
        // Chrome's own wording for an id that is already gone.
        if (!open.delete(id)) throw new Error('No window with id: ' + id)
      }),
    },
    tabs: { get: vi.fn(async (id: number) => ({ id, status: 'complete' })) },
    storage: {
      session: {
        get: vi.fn(async (keys: unknown) => {
          const out: Record<string, unknown> = {}
          for (const k of asList(keys)) if (k in session) out[k] = session[k]
          return out
        }),
        set: vi.fn(async (o: Record<string, unknown>) => {
          Object.assign(session, o)
        }),
        remove: vi.fn(async (keys: unknown) => {
          for (const k of asList(keys)) delete session[k]
        }),
      },
    },
    alarms: {
      create: vi.fn((name: string, info: unknown) => {
        alarms[name] = info
      }),
      clear: vi.fn(async (name: string) => delete alarms[name]),
    },
  }
}

/** Fresh module state (a newly-started service worker) over the given chrome. */
async function freshWorker(fake: ReturnType<typeof fakeBrowser>) {
  vi.resetModules()
  vi.stubGlobal('chrome', fake)
  return import('./researchTab')
}

test('a finished task closes the window immediately, without waiting for a timer', async () => {
  const fake = fakeBrowser()
  const { acquireTab, teardownNow } = await freshWorker(fake)

  const lease = await acquireTab()
  expect(fake.state.open.size).toBe(1)
  lease.release()

  // This is the call the SW makes from its own research.done handler, while it
  // is provably alive — the thing the old setTimeout could never rely on.
  await teardownNow()
  expect(fake.state.open.size).toBe(0)
})

test('teardown is armed by an alarm, not a setTimeout — the only timer that outlives the worker', async () => {
  const fake = fakeBrowser()
  const { acquireTab, JANITOR_ALARM } = await freshWorker(fake)
  const lease = await acquireTab()
  lease.release()
  expect(fake.state.alarms[JANITOR_ALARM]).toBeTruthy()
})

test('teardownNow leaves a window alone while another consumer still holds a lease', async () => {
  const fake = fakeBrowser()
  const { acquireTab, teardownNow } = await freshWorker(fake)
  const lease = await acquireTab()
  await teardownNow()
  expect(fake.state.open.size).toBe(1)
  lease.release()
})

test('the janitor waits out the idle grace, then closes the window', async () => {
  vi.useFakeTimers()
  try {
    const fake = fakeBrowser()
    const { acquireTab, runJanitorTick } = await freshWorker(fake)
    const lease = await acquireTab()
    lease.release()

    await runJanitorTick()
    expect(fake.state.open.size).toBe(1) // still inside the 60s grace

    vi.advanceTimersByTime(61_000)
    await runJanitorTick()
    expect(fake.state.open.size).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test('a worker that never heard of the window still closes it after an eviction', async () => {
  const fake = fakeBrowser()
  const first = await freshWorker(fake)
  const lease = await first.acquireTab()
  lease.release()
  expect(fake.state.open.size).toBe(1)

  // MV3 evicts the worker: module state (the window handle, the idle clock) is
  // gone, and chrome.storage.session is the only surviving record it existed.
  const revived = await freshWorker(fake)
  await revived.runJanitorTick()
  expect(fake.state.open.size).toBe(0)
})

test('a window Chrome hands back without a tab is closed, not leaked — and does not multiply', async () => {
  const fake = fakeBrowser({ tabsOnCreate: false })
  const { acquireTab } = await freshWorker(fake)

  // ensureTab cannot use a window with no tab, so it throws — but the window it
  // already created must not be abandoned. This is the path that produced
  // *accumulating* windows: the id was recorded nowhere, so neither the idle
  // teardown nor the orphan sweep could reach it, and the next acquire opened
  // another one.
  await expect(acquireTab()).rejects.toThrow(/could not open a research tab/)
  expect(fake.state.open.size).toBe(0)

  await expect(acquireTab()).rejects.toThrow(/could not open a research tab/)
  expect(fake.state.open.size).toBe(0)
})

test('the orphan sweep closes every stranded window, not just the newest', async () => {
  const fake = fakeBrowser()
  // Two windows stranded by successive evictions, plus one under the pre-list
  // key an in-place update would leave behind.
  fake.state.open.add(501).add(502).add(503)
  fake.state.session.researchRenderWindowIds = [501, 502]
  fake.state.session.researchRenderWindowId = 503

  const { sweepOrphanWindows } = await freshWorker(fake)
  await sweepOrphanWindows()
  expect(fake.state.open.size).toBe(0)
})
