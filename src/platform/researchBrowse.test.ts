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
