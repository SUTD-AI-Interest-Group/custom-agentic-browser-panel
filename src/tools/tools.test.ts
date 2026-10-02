import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Real closeTabs()/listTabFacts() touch chrome.tabs/chrome.storage directly;
// swap only these two out (importOriginal keeps every other export real —
// including planClosure's own module, tabPolicy.ts, which stays untouched)
// so the rest of createAgentTools' dependency graph loads exactly as it does
// in the real extension.
vi.mock('../platform/tabs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/tabs')>()
  return { ...actual, closeTabs: vi.fn() }
})
vi.mock('../platform/tabIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/tabIndex')>()
  return { ...actual, listTabFacts: vi.fn() }
})
// ControlPage/AutofillForm tests below drive the real point-of-no-return
// classifier and approval flow, but stub out the parts that would otherwise
// hit chrome.scripting.executeScript (snapshotPage, runControlStep) or the
// on-page overlay (presence.ts) or IndexedDB (getProfileMemories).
vi.mock('../platform/domIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/domIndex')>()
  return { ...actual, snapshotPage: vi.fn() }
})
vi.mock('./pageControl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pageControl')>()
  return { ...actual, runControlStep: vi.fn() }
})
vi.mock('../platform/presence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/presence')>()
  return {
    ...actual,
    mountPresence: vi.fn(async () => {}),
    setTint: vi.fn(async () => {}),
    focusOn: vi.fn(async () => {}),
    pulse: vi.fn(async () => {}),
    setPresenceHidden: vi.fn(async () => {}),
    unmountPresence: vi.fn(async () => {}),
    animateNavIntent: vi.fn(async () => {}),
  }
})
vi.mock('../data/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/memory')>()
  return { ...actual, getProfileMemories: vi.fn(async () => []) }
})

import { createAgentTools, type ApprovalGate, type PageControlGate, type PageTarget } from './tools'
import { closeTabs } from '../platform/tabs'
import { listTabFacts } from '../platform/tabIndex'
import { snapshotPage } from '../platform/domIndex'
import { runControlStep, type ControlSession } from './pageControl'
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import type { TabFacts } from './tabPolicy'

const fact = (over: Partial<TabFacts> & { tabId: number }): TabFacts & { url: string } => ({
  windowId: 1,
  title: `Tab ${over.tabId}`,
  host: 'example.com',
  url: 'https://example.com/',
  pinned: false,
  active: false,
  groupId: -1,
  ...over,
})

const noopPageControl: PageControlGate = {
  requestSession: async () => false,
  session: () => null,
  endSession: () => {},
}

function buildTools() {
  const requestApproval: ApprovalGate = async () => true
  return createAgentTools(
    requestApproval,
    'all-tabs', // CloseTabs is deleted entirely in 'active-tab' mode
    new Set(),
    noopPageControl,
    null,
    false,
    [],
    () => 'always',
    'conv-1',
    new Set(),
  )
}

describe("CloseTabs — reports the count closeTabs() actually verified, not the pre-approval plan (cross-owner w/ W1-C's tabs.ts)", () => {
  beforeEach(() => {
    vi.mocked(closeTabs).mockReset()
    vi.mocked(listTabFacts).mockReset()
  })

  it('reports result.closed.length even when a planned tab vanished before closeTabs() ran', async () => {
    // Three tabs in one window so planClosure accepts closing two of them
    // without emptying (and so auto-rejecting) the window.
    vi.mocked(listTabFacts).mockResolvedValue([
      fact({ tabId: 1, windowId: 1 }),
      fact({ tabId: 2, windowId: 1 }),
      fact({ tabId: 3, windowId: 1 }),
    ])
    // The plan wants both 1 and 2 closed, but by the time closeTabs() actually
    // ran (past the human-reaction-time approval wait), only one was still
    // there to stash+remove — exactly W1-C's fixed closeTabs() behavior.
    vi.mocked(closeTabs).mockResolvedValue({
      closed: [{ url: 'https://a.test', title: 'A', windowId: 1, index: 0, pinned: false }],
      recoverable: 1,
    })

    const tools = buildTools()
    const result = (await (tools.CloseTabs as any).execute(
      { action: 'close', reason: 'cleanup', tabIds: [1, 2] },
      {} as any,
    )) as { closed: number; error?: string }

    expect(result.error).toBeUndefined()
    // The regression this guards: reporting plan.close.length (2, what was
    // PLANNED) instead of result.closed.length (1, what closeTabs() actually
    // verified) would tell the user "closed 2 tabs" when only 1 really closed
    // — exactly the honesty failure the tab-policy invariant exists to prevent.
    expect(result.closed).toBe(1)
  })

  it('reports the full count when nothing vanished between planning and closing', async () => {
    vi.mocked(listTabFacts).mockResolvedValue([
      fact({ tabId: 1, windowId: 1 }),
      fact({ tabId: 2, windowId: 1 }),
      fact({ tabId: 3, windowId: 1 }),
    ])
    vi.mocked(closeTabs).mockResolvedValue({
      closed: [
        { url: 'https://a.test', title: 'A', windowId: 1, index: 0, pinned: false },
        { url: 'https://b.test', title: 'B', windowId: 1, index: 1, pinned: false },
      ],
      recoverable: 2,
    })

    const tools = buildTools()
    const result = (await (tools.CloseTabs as any).execute(
      { action: 'close', reason: 'cleanup', tabIds: [1, 2] },
      {} as any,
    )) as { closed: number }

    expect(result.closed).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// ControlPage / AutofillForm — foreground is re-checked after a card's
// human-reaction-time wait, not just once at tool entry. See the doc comment
// on isForeground (tools.ts) for why: the card sits on screen for as long as
// the human takes to react, and a committing action must not fire against a
// tab they've since switched away from.
// ---------------------------------------------------------------------------

const FG_TAB = { id: 1, windowId: 1, url: 'https://example.com/' } as chrome.tabs.Tab
// A different tab in the same window becoming active is exactly what
// isForeground (tools.ts) treats as "the user switched away".
const BG_TAB = { id: 2, windowId: 1, url: 'https://example.com/elsewhere' } as chrome.tabs.Tab

function el(over: Partial<IndexedElement> & { index: number }): IndexedElement {
  return {
    tag: 'button',
    name: `Element ${over.index}`,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    sensitive: false,
    ...over,
  }
}

function snap(elements: IndexedElement[], origin = 'https://example.com'): PageSnapshot {
  return { url: 'https://example.com/', title: 'Example', origin, dpr: 1, elements, text: 'registry', truncated: false }
}

function buildSession(over: Partial<ControlSession> = {}): ControlSession {
  return { tabId: 1, origin: 'https://example.com', plan: 'test plan', active: true, ...over }
}

/** Queues one `chrome.tabs.query` resolution per call, in order. */
function stubTabsQuery(...sequence: chrome.tabs.Tab[]) {
  const query = vi.fn()
  for (const tab of sequence) query.mockResolvedValueOnce([tab])
  vi.stubGlobal('chrome', { tabs: { query } })
  return query
}

function buildControlTools(opts: {
  session: ControlSession
  requestApproval?: ApprovalGate
  park?: (reason: string) => void
}) {
  const pageControl: PageControlGate = {
    requestSession: async () => true,
    session: () => opts.session,
    endSession: () => {
      opts.session.active = false
    },
  }
  const pageTarget: PageTarget = {
    resolveTab: async () => FG_TAB,
    park: opts.park ?? (() => {}),
  }
  return createAgentTools(
    opts.requestApproval ?? (async () => true),
    'all-tabs',
    new Set(),
    pageControl,
    null,
    false,
    [],
    () => 'always',
    'conv-1',
    new Set(),
    undefined,
    undefined,
    pageTarget,
  )
}

describe('ControlPage — re-checks isForeground after the approval wait on a point-of-no-return step', () => {
  beforeEach(() => {
    vi.mocked(snapshotPage).mockReset()
    vi.mocked(runControlStep).mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('runs the action when the tab is still foreground once the user approves', async () => {
    stubTabsQuery(FG_TAB, FG_TAB) // entry check, then the post-approval recheck
    vi.mocked(snapshotPage).mockResolvedValue(snap([el({ index: 0, name: 'Continue' })]))
    vi.mocked(runControlStep).mockResolvedValue({ ok: true, message: 'clicked', registry: 'fresh', origin: 'https://example.com' })

    const tools = buildControlTools({ session: buildSession() })
    const result = (await (tools.ControlPage as any).execute(
      { action: 'click', index: 0, sensitive: true },
      {} as any,
    )) as { ok?: boolean; parked?: boolean }

    expect(result.ok).toBe(true)
    expect(runControlStep).toHaveBeenCalledTimes(1)
  })

  it('parks instead of acting when the user switched tabs while the approval card was open', async () => {
    stubTabsQuery(FG_TAB, BG_TAB) // entry check passes, but the card's wait outlasts it
    vi.mocked(snapshotPage).mockResolvedValue(snap([el({ index: 0, name: 'Continue' })]))
    vi.mocked(runControlStep).mockResolvedValue({ ok: true, message: 'clicked', registry: 'fresh', origin: 'https://example.com' })

    const parked: string[] = []
    const tools = buildControlTools({ session: buildSession(), park: (reason) => parked.push(reason) })
    const result = (await (tools.ControlPage as any).execute(
      { action: 'click', index: 0, sensitive: true },
      {} as any,
    )) as { parked?: boolean }

    expect(result.parked).toBe(true)
    expect(parked).toHaveLength(1)
    // The whole point: a committing click must never fire once the human
    // reading the card is no longer looking at the tab it will act on.
    expect(runControlStep).not.toHaveBeenCalled()
  })
})

describe('AutofillForm — re-checks isForeground per field, not only at tool entry', () => {
  beforeEach(() => {
    vi.mocked(snapshotPage).mockReset()
    vi.mocked(runControlStep).mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fills every field when the tab stays foreground throughout', async () => {
    stubTabsQuery(FG_TAB, FG_TAB, FG_TAB) // entry check, then one per field
    vi.mocked(snapshotPage).mockResolvedValue(
      snap([el({ index: 0, name: 'First name' }), el({ index: 1, name: 'Last name' })]),
    )
    vi.mocked(runControlStep).mockResolvedValue({ ok: true, message: 'typed', registry: 'fresh', origin: 'https://example.com' })

    const tools = buildControlTools({ session: buildSession() })
    const result = (await (tools.AutofillForm as any).execute(
      { fields: [{ index: 0, value: 'Ada' }, { index: 1, value: 'Lovelace' }] },
      {} as any,
    )) as { filled: number[] }

    expect(result.filled).toEqual([0, 1])
    expect(runControlStep).toHaveBeenCalledTimes(2)
  })

  it('stops the batch when the tab backgrounds mid-fill, leaving later fields untouched', async () => {
    // entry check, top-of-loop for field 0 (still foreground), top-of-loop
    // for field 1 (user has since switched tabs)
    stubTabsQuery(FG_TAB, FG_TAB, BG_TAB)
    vi.mocked(snapshotPage).mockResolvedValue(
      snap([el({ index: 0, name: 'First name' }), el({ index: 1, name: 'Last name' })]),
    )
    vi.mocked(runControlStep).mockResolvedValue({ ok: true, message: 'typed', registry: 'fresh', origin: 'https://example.com' })

    const parked: string[] = []
    const tools = buildControlTools({ session: buildSession(), park: (reason) => parked.push(reason) })
    const result = (await (tools.AutofillForm as any).execute(
      { fields: [{ index: 0, value: 'Ada' }, { index: 1, value: 'Lovelace' }] },
      {} as any,
    )) as { filled: number[]; parked?: boolean }

    expect(result.filled).toEqual([0])
    expect(result.parked).toBe(true)
    expect(parked).toHaveLength(1)
    // Field 1 was never touched — the batch stopped, it didn't just skip one field.
    expect(runControlStep).toHaveBeenCalledTimes(1)
  })

  it('stops before typing a sensitive field once the tab backgrounds during its approval wait', async () => {
    // entry check, top-of-loop for the one field (still foreground), then the
    // post-approval recheck once the sensitive-field card resolves
    stubTabsQuery(FG_TAB, FG_TAB, BG_TAB)
    vi.mocked(snapshotPage).mockResolvedValue(snap([el({ index: 0, name: 'Card number', sensitive: true })]))
    vi.mocked(runControlStep).mockResolvedValue({ ok: true, message: 'typed', registry: 'fresh', origin: 'https://example.com' })

    const parked: string[] = []
    const tools = buildControlTools({
      session: buildSession(),
      park: (reason) => parked.push(reason),
      requestApproval: async () => true,
    })
    const result = (await (tools.AutofillForm as any).execute(
      { fields: [{ index: 0, value: '4111', sensitive: true }] },
      {} as any,
    )) as { filled: number[]; parked?: boolean }

    expect(result.filled).toEqual([])
    expect(result.parked).toBe(true)
    expect(parked).toHaveLength(1)
    expect(runControlStep).not.toHaveBeenCalled()
  })
})
