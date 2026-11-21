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
// The assist path's one chat-model call (src/decider/profileLookup.ts), driven through the REAL
// panel hooks in the "Review Focus 4" tests below.
vi.mock('../decider/profileLookup', () => ({ profileLookup: vi.fn() }))

import { createAgentTools, type ApprovalGate, type PageControlGate, type PageTarget } from './tools'
import { closeTabs } from '../platform/tabs'
import { listTabFacts } from '../platform/tabIndex'
import { snapshotPage } from '../platform/domIndex'
import { runControlStep, type ControlSession } from './pageControl'
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import type { TabFacts } from './tabPolicy'
import { createDeciderHooks, type DeciderHooks } from '../decider/hooks'
import { forwardDeciderHooks } from '../decider/relay'
import { asSchema } from 'ai'
import type { FillPlan } from '../decider/fillPlan'
import { profileLookup } from '../decider/profileLookup'
import { getProfileMemories, type MemoryRecord } from '../data/memory'

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

  it('selects into a <select> and types into text, on the fields path (a select used to be typed into and fail)', async () => {
    stubTabsQuery(FG_TAB, FG_TAB, FG_TAB)
    vi.mocked(snapshotPage).mockResolvedValue(
      snap([el({ index: 0, name: 'Name' }), el({ index: 1, tag: 'select', type: 'select-one', name: 'Topic' })]),
    )
    vi.mocked(runControlStep).mockResolvedValue({ ok: true, message: 'ok', registry: 'fresh', origin: 'https://example.com' })
    const tools = buildControlTools({ session: buildSession() })
    const result = (await (tools.AutofillForm as any).execute(
      { fields: [{ index: 0, value: 'Ada' }, { index: 1, value: 'Billing' }] },
      {} as any,
    )) as { filled: number[] }
    expect(vi.mocked(runControlStep).mock.calls.map(([d]) => d.spec)).toEqual([
      { action: 'type', index: 0, text: 'Ada', clear: true, sensitive: undefined },
      { action: 'select', index: 1, value: 'Billing' },
    ])
    expect(result.filled).toEqual([0, 1])
  })

  it('a select flagged sensitive:true still raises the once:true card (the select swap keeps the flag)', async () => {
    stubTabsQuery(FG_TAB, FG_TAB, FG_TAB, FG_TAB)
    vi.mocked(snapshotPage).mockResolvedValue(snap([el({ index: 0, tag: 'select', type: 'select-one', name: 'Plan' })]))
    vi.mocked(runControlStep).mockResolvedValue({ ok: true, message: 'ok', registry: 'fresh', origin: 'https://example.com' })
    const requestApproval = vi.fn(async () => false)
    const tools = buildControlTools({ session: buildSession(), requestApproval })
    await (tools.AutofillForm as any).execute({ fields: [{ index: 0, value: 'Pro', sensitive: true }] }, {} as any)
    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'AutofillForm', once: true }))
    expect(runControlStep).not.toHaveBeenCalled()
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

// ---------------------------------------------------------------------------
// The shadow decider (src/decider/hooks.ts) is additive: ControlPage's result
// must not depend on it in any way — not its latency, not its failure, not a
// decision that never settles (Review Focus 2: the WASM fallback takes seconds).
// ---------------------------------------------------------------------------

function buildDeciderTools(opts: { session: ControlSession; decider?: DeciderHooks; requestApproval?: ApprovalGate; pageControl?: PageControlGate }) {
  const pageControl: PageControlGate = opts.pageControl ?? {
    requestSession: async () => true,
    session: () => opts.session,
    endSession: () => {
      opts.session.active = false
    },
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
    { resolveTab: async () => FG_TAB, park: () => {} },
    opts.decider,
  )
}

function stubHooks(over: Partial<DeciderHooks> = {}): DeciderHooks {
  return {
    mode: () => 'shadow',
    settingsMode: () => 'shadow',
    threshold: () => 0.6,
    sessionGranted: vi.fn(),
    observeStep: vi.fn(),
    observeFill: vi.fn(),
    mapForm: vi.fn(async () => ({ error: 'unused' })),
    next: vi.fn(async () => ({ error: 'unused' })),
    ...over,
  }
}

/** Resolves with the value, or rejects after `ms` — so a hang fails fast instead of timing out the file. */
function within<T>(p: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))])
}

describe('ControlPage — the shadow decider never changes or delays a step', () => {
  beforeEach(() => {
    vi.mocked(snapshotPage).mockReset()
    vi.mocked(runControlStep).mockReset()
    vi.mocked(snapshotPage).mockResolvedValue(snap([el({ index: 0, name: 'Name', tag: 'input' }), el({ index: 1, name: 'Next' })]))
    vi.mocked(runControlStep).mockResolvedValue({ ok: true, message: 'clicked', registry: 'fresh', origin: 'https://example.com' })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const NORMAL = { ok: true, message: 'clicked', urlChanged: false, elements: 'fresh' }

  it('returns its normal result while observeStep holds a promise that never settles', async () => {
    stubTabsQuery(FG_TAB)
    // Typed void, but an implementation that started awaiting it would hang right here.
    const observeStep = vi.fn(() => new Promise<never>(() => {})) as unknown as DeciderHooks['observeStep']
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks({ observeStep }) })
    const result = await within((tools.ControlPage as any).execute({ action: 'click', index: 1 }, {} as any))
    expect(result).toEqual(NORMAL)
    expect(runControlStep).toHaveBeenCalledTimes(1)
    expect(observeStep).toHaveBeenCalledTimes(1)
  })

  it('returns its normal result with the real hooks while the engine never answers', async () => {
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn(async () => [FG_TAB]) },
      // readViewportText's injection: answers, so the hooks reach engine.decide.
      scripting: { executeScript: vi.fn(async () => [{ result: 'page text' }]) },
    })
    const decide = vi.fn(() => new Promise<never>(() => {}))
    const decider = createDeciderHooks({
      settings: () => ({ mode: 'shadow' }),
      conversationId: 'conv-1',
      currentGoal: () => 'click next',
      chatModel: () => null,
      engine: { decide, warm: vi.fn(async () => {}) },
      modelReady: async () => true,
    })
    decider.sessionGranted() // resolves readiness, as RequestPageControl would have
    await new Promise((r) => setTimeout(r, 10))
    const tools = buildDeciderTools({ session: buildSession(), decider })
    const result = await within((tools.ControlPage as any).execute({ action: 'click', index: 1 }, {} as any))
    expect(result).toEqual(NORMAL)
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1)) // it really was in flight
  })

  it('returns its normal result when observeStep throws synchronously', async () => {
    stubTabsQuery(FG_TAB)
    const observeStep = vi.fn(() => {
      throw new Error('decider bug')
    })
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks({ observeStep }) })
    const result = await within((tools.ControlPage as any).execute({ action: 'click', index: 1 }, {} as any))
    expect(result).toEqual(NORMAL)
  })

  it('observes the step it was handed, before the point-of-no-return card', async () => {
    stubTabsQuery(FG_TAB, FG_TAB)
    const order: string[] = []
    const observeStep = vi.fn(() => {
      order.push('observe')
    })
    const requestApproval: ApprovalGate = vi.fn(async () => {
      order.push('approval')
      return true
    })
    const session = buildSession()
    const tools = buildDeciderTools({ session, decider: stubHooks({ observeStep }), requestApproval })
    const spec = { action: 'click', index: 1, sensitive: true }
    await within((tools.ControlPage as any).execute(spec, {} as any))
    expect(order).toEqual(['observe', 'approval'])
    expect(observeStep).toHaveBeenCalledWith({
      tabId: 1,
      snap: expect.objectContaining({ url: 'https://example.com/', elements: expect.any(Array) }),
      spec,
      session,
    })
  })

  it('without a decider, behaves exactly as before', async () => {
    stubTabsQuery(FG_TAB)
    const tools = buildDeciderTools({ session: buildSession() })
    const result = await within((tools.ControlPage as any).execute({ action: 'click', index: 1 }, {} as any))
    expect(result).toEqual(NORMAL)
  })
})

describe('RequestPageControl — tells the decider a session was granted', () => {
  beforeEach(() => {
    vi.mocked(snapshotPage).mockReset()
    vi.mocked(snapshotPage).mockResolvedValue(snap([el({ index: 0 })]))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function requestTools(granted: boolean, decider: DeciderHooks) {
    const pageControl: PageControlGate = { requestSession: async () => granted, session: () => null, endSession: () => {} }
    return createAgentTools(
      async () => true, 'all-tabs', new Set(), pageControl, null, false, [], () => 'always', 'conv-1', new Set(),
      undefined, undefined, { resolveTab: async () => FG_TAB, park: () => {} }, decider,
    )
  }

  it('calls sessionGranted after the grant, and never awaits it', async () => {
    stubTabsQuery(FG_TAB)
    const sessionGranted = vi.fn(() => new Promise<never>(() => {})) as unknown as DeciderHooks['sessionGranted']
    const result = await within((requestTools(true, stubHooks({ sessionGranted })).RequestPageControl as any).execute({ plan: 'p' }, {} as any))
    expect(result).toMatchObject({ started: true })
    expect(sessionGranted).toHaveBeenCalledTimes(1)
  })

  const ASSIST_NOTE =
    'Assist mode is on: for a form, call AutofillForm with `values` (the details from the user\'s request) and omit `fields` — the decision model maps the fields from the user\'s saved profile in one step.'

  it('tells the model about the Assist path on the grant — in Assist mode only', async () => {
    stubTabsQuery(FG_TAB)
    const assist = await within((requestTools(true, stubHooks({ mode: () => 'assist' })).RequestPageControl as any).execute({ plan: 'p' }, {} as any))
    expect(assist).toMatchObject({ started: true, note: ASSIST_NOTE })

    for (const decider of [stubHooks({ mode: () => 'shadow' }), stubHooks({ mode: () => 'off' }), undefined]) {
      stubTabsQuery(FG_TAB)
      const result = await within((requestTools(true, decider as DeciderHooks).RequestPageControl as any).execute({ plan: 'p' }, {} as any))
      expect(result).toMatchObject({ started: true })
      expect(result).not.toHaveProperty('note')
    }

    stubTabsQuery(FG_TAB)
    const broken = stubHooks({ mode: () => { throw new Error('decider bug') } })
    const survives = await within((requestTools(true, broken).RequestPageControl as any).execute({ plan: 'p' }, {} as any))
    expect(survives).toMatchObject({ started: true })
    expect(survives).not.toHaveProperty('note')
  })

  it('does not call it when the user denies the session, and survives it throwing', async () => {
    stubTabsQuery(FG_TAB)
    const denied = vi.fn()
    await within((requestTools(false, stubHooks({ sessionGranted: denied })).RequestPageControl as any).execute({ plan: 'p' }, {} as any))
    expect(denied).not.toHaveBeenCalled()

    stubTabsQuery(FG_TAB)
    const throws = vi.fn(() => {
      throw new Error('decider bug')
    })
    const result = await within((requestTools(true, stubHooks({ sessionGranted: throws })).RequestPageControl as any).execute({ plan: 'p' }, {} as any))
    expect(result).toMatchObject({ started: true })
  })
})

// ---------------------------------------------------------------------------
// AutofillForm — assist mode: without `fields`, the decision model maps the form
// (hooks.mapForm) and the SAME per-field loop executes the plan, every guard intact.
// ---------------------------------------------------------------------------

const ASSIST_FORM = [
  el({ index: 0, tag: 'input', type: 'text', name: 'Full name' }),
  el({ index: 1, tag: 'select', name: 'Topic' }),
  el({ index: 2, tag: 'input', type: 'checkbox', name: 'I agree to be contacted', checked: false }),
  el({ index: 3, tag: 'input', type: 'text', name: 'Phone number' }),
  el({ index: 4, tag: 'button', type: 'submit', name: 'Send message' }),
]

const ASSIST_PLAN: FillPlan = {
  fills: [
    { index: 0, kind: 'text', key: 'profile.full_name', value: 'Ada Lovelace', p: 0.9 },
    { index: 1, kind: 'select', key: 'Billing', value: 'Billing', p: 0.95 },
    { index: 2, kind: 'checkbox', key: 'tick', value: 'tick', p: 0.8 },
  ],
  left: [{ index: 3, reason: 'low-confidence' }], // the decider's p was 0.4, under the 0.6 threshold
}

const FIELDS_REQUIRED = { error: 'fields is required unless the decision model is in Assist mode and ready.' }

/** Every tab query answers "still in front": these tests are about the plan, not parking. */
function stubForeground() {
  vi.stubGlobal('chrome', { tabs: { query: vi.fn(async () => [FG_TAB]) } })
}

/** No runControlStep call may ever click a submit control — the property, checked after every test. */
function assertNoSubmitClicked() {
  for (const [deps] of vi.mocked(runControlStep).mock.calls) {
    if (deps.spec.action !== 'click' || deps.spec.index === undefined) continue
    const target = deps.snapshot.elements.find((e) => e.index === deps.spec.index)
    expect(target?.type, `clicked [${deps.spec.index}]`).not.toBe('submit')
    // Stronger still: the decider path only ever clicks an (unchecked) checkbox.
    expect(target?.type, `clicked [${deps.spec.index}]`).toBe('checkbox')
  }
}

describe('AutofillForm — assist mode, without fields', () => {
  beforeEach(() => {
    vi.mocked(snapshotPage).mockReset()
    vi.mocked(runControlStep).mockReset()
    vi.mocked(snapshotPage).mockResolvedValue(snap(ASSIST_FORM))
    vi.mocked(runControlStep).mockResolvedValue({ ok: true, message: 'done', registry: 'fresh', origin: 'https://example.com' })
    stubForeground()
  })
  afterEach(() => {
    assertNoSubmitClicked()
    vi.unstubAllGlobals()
  })

  it.each(['shadow', 'off'] as const)("does not run the decider path in %s mode: without fields it is an error", async (mode) => {
    const mapForm = vi.fn(async () => ASSIST_PLAN)
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks({ mode: () => mode, mapForm }) })
    expect(await within((tools.AutofillForm as any).execute({ values: { message: 'hi' } }, {} as any))).toEqual(FIELDS_REQUIRED)
    expect(mapForm).not.toHaveBeenCalled()
    expect(runControlStep).not.toHaveBeenCalled()
  })

  it('without a decider at all, omitting fields is the same error', async () => {
    const tools = buildDeciderTools({ session: buildSession() })
    expect(await within((tools.AutofillForm as any).execute({}, {} as any))).toEqual(FIELDS_REQUIRED)
    expect(runControlStep).not.toHaveBeenCalled()
  })

  it('fills the plan with the per-field loop (text → type+clear, select → select, checkbox → click) and returns what it left', async () => {
    const mapForm = vi.fn(async () => ASSIST_PLAN)
    const session = buildSession()
    const tools = buildDeciderTools({ session, decider: stubHooks({ mode: () => 'assist', mapForm }) })
    const values = { message: 'My last invoice was charged twice.' }
    const result = await within((tools.AutofillForm as any).execute({ values }, {} as any))

    expect(mapForm).toHaveBeenCalledTimes(1)
    expect(mapForm).toHaveBeenCalledWith({ tabId: 1, snap: expect.objectContaining({ elements: ASSIST_FORM }), session, values })
    expect(runControlStep).toHaveBeenCalledTimes(3)
    expect(vi.mocked(runControlStep).mock.calls.map(([d]) => d.spec)).toEqual([
      { action: 'type', index: 0, text: 'Ada Lovelace', clear: true },
      { action: 'select', index: 1, value: 'Billing' },
      { action: 'click', index: 2 },
    ])
    expect(result).toMatchObject({
      filled: [0, 1, 2],
      left: [{ index: 3, reason: 'low-confidence' }],
      mapped: [
        { index: 0, key: 'profile.full_name' },
        { index: 1, key: 'Billing' },
        { index: 2, key: 'tick' },
      ],
    })
    // Values never echo back into the model's history through `mapped`.
    expect(JSON.stringify((result as { mapped: unknown }).mapped)).not.toContain('Ada Lovelace')
  })

  it('passes no values as an empty record', async () => {
    const mapForm = vi.fn(async () => ({ fills: [], left: [] }))
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks({ mode: () => 'assist', mapForm }) })
    await within((tools.AutofillForm as any).execute({}, {} as any))
    expect(mapForm).toHaveBeenCalledWith(expect.objectContaining({ values: {} }))
  })

  it('still raises the one-shot card for a plan fill on a sensitive element, and skips it when denied', async () => {
    const form = [el({ index: 0, tag: 'input', type: 'text', name: 'Full name' }), el({ index: 1, tag: 'input', type: 'text', name: 'Card number', sensitive: true })]
    vi.mocked(snapshotPage).mockResolvedValue(snap(form))
    const plan: FillPlan = {
      fills: [
        { index: 1, kind: 'text', key: 'request.card', value: '4111 1111 1111 1111', p: 0.99 },
        { index: 0, kind: 'text', key: 'profile.full_name', value: 'Ada Lovelace', p: 0.9 },
      ],
      left: [],
    }
    const requestApproval = vi.fn(async () => false)
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks({ mode: () => 'assist', mapForm: async () => plan }), requestApproval })
    const result = await within((tools.AutofillForm as any).execute({}, {} as any))
    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'AutofillForm', once: true }))
    expect(runControlStep).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runControlStep).mock.calls[0][0].spec).toMatchObject({ action: 'type', index: 0 })
    expect(result).toMatchObject({ filled: [0] })
  })

  it('never clicks a submit control, even when a plan says to — nor anything but an unchecked checkbox', async () => {
    const plan: FillPlan = {
      fills: [
        { index: 4, kind: 'checkbox', key: 'tick', value: 'tick', p: 0.99 }, // [4] is the submit button
        { index: 2, kind: 'checkbox', key: 'tick', value: 'tick', p: 0.9 },
      ],
      left: [],
    }
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks({ mode: () => 'assist', mapForm: async () => plan }) })
    const result = await within((tools.AutofillForm as any).execute({}, {} as any))
    expect(runControlStep).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runControlStep).mock.calls[0][0].spec).toEqual({ action: 'click', index: 2 })
    expect(result).toMatchObject({ filled: [2] })
  })

  it('does not click a checkbox that is already ticked when its turn comes (a click would untick it)', async () => {
    vi.mocked(snapshotPage)
      .mockResolvedValueOnce(snap(ASSIST_FORM)) // what the plan was made from
      .mockResolvedValue(snap(ASSIST_FORM.map((e) => (e.index === 2 ? { ...e, checked: true } : e))))
    const plan: FillPlan = { fills: [{ index: 2, kind: 'checkbox', key: 'tick', value: 'tick', p: 0.9 }], left: [] }
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks({ mode: () => 'assist', mapForm: async () => plan }) })
    const result = await within((tools.AutofillForm as any).execute({}, {} as any))
    expect(runControlStep).not.toHaveBeenCalled()
    expect(result).toMatchObject({ filled: [], left: [{ index: 2, reason: 'already-set' }] })
  })

  it('unticks a ticked checkbox for an untick fill, and only a ticked one', async () => {
    const ticked = ASSIST_FORM.map((e) => (e.index === 2 ? { ...e, checked: true } : e))
    vi.mocked(snapshotPage).mockResolvedValue(snap(ticked))
    const plan: FillPlan = { fills: [{ index: 2, kind: 'checkbox', key: 'untick', value: 'untick', p: 0.1 }], left: [] }
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks({ mode: () => 'assist', mapForm: async () => plan }) })
    const result = await within((tools.AutofillForm as any).execute({}, {} as any))
    expect(vi.mocked(runControlStep).mock.calls.map(([d]) => d.spec)).toEqual([{ action: 'click', index: 2 }])
    expect(result).toMatchObject({ filled: [2], mapped: [{ index: 2, key: 'untick' }] })
  })

  it('does not click an unticked checkbox for an untick fill (a click would tick it)', async () => {
    // untick, but the box is unticked: a click would tick it
    const plan: FillPlan = { fills: [{ index: 2, kind: 'checkbox', key: 'untick', value: 'untick', p: 0.1 }], left: [] }
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks({ mode: () => 'assist', mapForm: async () => plan }) })
    const r1 = await within((tools.AutofillForm as any).execute({}, {} as any))
    expect(runControlStep).not.toHaveBeenCalled()
    expect(r1).toMatchObject({ filled: [], left: [{ index: 2, reason: 'already-set' }] })
  })

  it('refuses a tick plan against a ticked box and an untick plan against an unticked box, in both guards', async () => {
    // Snapshot changes between planning and acting would be caught by hasElementChanged; here the
    // plan itself disagrees with the page, so only the direction guards stand in the way.
    const ticked = ASSIST_FORM.map((e) => (e.index === 2 ? { ...e, checked: true } : e))
    const run = async (form: typeof ASSIST_FORM, value: 'tick' | 'untick') => {
      vi.mocked(runControlStep).mockClear()
      vi.mocked(snapshotPage).mockResolvedValue(snap(form))
      const plan: FillPlan = { fills: [{ index: 2, kind: 'checkbox', key: value, value, p: 0.9 }], left: [] }
      const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks({ mode: () => 'assist', mapForm: async () => plan }) })
      return within((tools.AutofillForm as any).execute({}, {} as any))
    }
    expect(await run(ticked, 'tick')).toMatchObject({ filled: [] })
    expect(runControlStep).not.toHaveBeenCalled()
    expect(await run(ASSIST_FORM, 'untick')).toMatchObject({ filled: [] })
    expect(runControlStep).not.toHaveBeenCalled()
    expect(await run(ASSIST_FORM, 'tick')).toMatchObject({ filled: [2] })
    expect(await run(ticked, 'untick')).toMatchObject({ filled: [2] })
  })

  it('never clicks a submit control for an untick fill either', async () => {
    const plan: FillPlan = { fills: [{ index: 4, kind: 'checkbox', key: 'untick', value: 'untick', p: 0.05 }], left: [] }
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks({ mode: () => 'assist', mapForm: async () => plan }) })
    await within((tools.AutofillForm as any).execute({}, {} as any))
    expect(runControlStep).not.toHaveBeenCalled()
  })

  it('ends the session when the origin changes between fields, as the fields path does', async () => {
    vi.mocked(snapshotPage)
      .mockResolvedValueOnce(snap(ASSIST_FORM)) // the plan's snapshot
      .mockResolvedValueOnce(snap(ASSIST_FORM)) // field [0]
      .mockResolvedValue(snap(ASSIST_FORM, 'https://evil.example')) // field [1]: the page moved
    const session = buildSession()
    const tools = buildDeciderTools({ session, decider: stubHooks({ mode: () => 'assist', mapForm: async () => ASSIST_PLAN }) })
    const result = await within((tools.AutofillForm as any).execute({}, {} as any))
    expect(result).toEqual({
      filled: [0],
      error: 'The page is now on a different site; autofill stopped and page control ended for safety.',
    })
    expect(session.active).toBe(false)
    expect(runControlStep).toHaveBeenCalledTimes(1)
  })

  it('ends the session without deciding when the page already moved before the plan was made', async () => {
    vi.mocked(snapshotPage).mockResolvedValue(snap(ASSIST_FORM, 'https://evil.example'))
    const mapForm = vi.fn(async () => ASSIST_PLAN)
    const session = buildSession()
    const tools = buildDeciderTools({ session, decider: stubHooks({ mode: () => 'assist', mapForm }) })
    const result = await within((tools.AutofillForm as any).execute({}, {} as any))
    expect(result).toMatchObject({ filled: [], error: expect.stringContaining('different site') })
    expect(session.active).toBe(false)
    expect(mapForm).not.toHaveBeenCalled()
  })

  it('needs an open session first, like every page-control tool', async () => {
    const mapForm = vi.fn(async () => ASSIST_PLAN)
    const tools = buildDeciderTools({ session: buildSession({ active: false }), decider: stubHooks({ mode: () => 'assist', mapForm }) })
    expect(await within((tools.AutofillForm as any).execute({}, {} as any))).toEqual({
      error: 'No page-control session is open. Call RequestPageControl first.',
    })
    expect(mapForm).not.toHaveBeenCalled()
  })

  const MAPPING_ENDED = { filled: [], error: 'Page control ended while the form was being mapped; nothing more was filled.' }

  it('fills nothing when page control ends while the form is being mapped (Stop during the wait)', async () => {
    const session = buildSession()
    const gate: PageControlGate = {
      requestSession: async () => true,
      session: () => (session.active ? session : null),
      endSession: () => {
        session.active = false
      },
    }
    // The user pressed Stop while the panel was still mapping: the session ends, then the plan arrives.
    const mapForm = vi.fn(async () => {
      gate.endSession()
      return ASSIST_PLAN
    })
    const tools = buildDeciderTools({ session, pageControl: gate, decider: stubHooks({ mode: () => 'assist', mapForm }) })
    expect(await within((tools.AutofillForm as any).execute({}, {} as any))).toEqual(MAPPING_ENDED)
    expect(runControlStep).not.toHaveBeenCalled()
  })

  it('fills nothing when a different session replaced this one during the wait', async () => {
    const session = buildSession()
    let current: ControlSession = session
    const gate: PageControlGate = { requestSession: async () => true, session: () => current, endSession: () => {} }
    const mapForm = vi.fn(async () => {
      current = buildSession() // a fresh grant: same tab, same origin, but not the session this call was made in
      return ASSIST_PLAN
    })
    const tools = buildDeciderTools({ session, pageControl: gate, decider: stubHooks({ mode: () => 'assist', mapForm }) })
    expect(await within((tools.AutofillForm as any).execute({}, {} as any))).toEqual(MAPPING_ENDED)
    expect(runControlStep).not.toHaveBeenCalled()
  })

  it('fills nothing when the call is aborted during the wait, and hands mapForm the signal so the wait can end early', async () => {
    const controller = new AbortController()
    const mapForm = vi.fn(async (i: { signal?: AbortSignal }) => {
      expect(i.signal).toBe(controller.signal)
      controller.abort()
      return ASSIST_PLAN
    })
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks({ mode: () => 'assist', mapForm: mapForm as DeciderHooks['mapForm'] }) })
    expect(await within((tools.AutofillForm as any).execute({}, { abortSignal: controller.signal } as any))).toEqual(MAPPING_ENDED)
    expect(mapForm).toHaveBeenCalledTimes(1)
    expect(runControlStep).not.toHaveBeenCalled()
  })

  it('stops mid-batch when page control ends between fields', async () => {
    const session = buildSession()
    vi.mocked(runControlStep).mockImplementationOnce(async () => {
      session.active = false // Stop, while the first field was being typed
      return { ok: true, message: 'typed', registry: 'fresh', origin: 'https://example.com' }
    })
    const tools = buildDeciderTools({ session, decider: stubHooks({ mode: () => 'assist', mapForm: async () => ASSIST_PLAN }) })
    expect(await within((tools.AutofillForm as any).execute({}, {} as any))).toEqual({
      filled: [0],
      error: 'Page control ended while the form was being filled; nothing more was filled.',
    })
    expect(runControlStep).toHaveBeenCalledTimes(1)
  })

  it('counts a field as filled only when its action succeeded; a failed one is left, reason "failed"', async () => {
    vi.mocked(runControlStep)
      .mockResolvedValueOnce({ ok: true, message: 'typed', registry: 'fresh', origin: 'https://example.com' })
      .mockResolvedValueOnce({ ok: false, message: 'no option matching "Billing" in element 1', registry: 'fresh', origin: 'https://example.com' })
      .mockRejectedValueOnce(new Error('Frame with ID 0 was removed.'))
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks({ mode: () => 'assist', mapForm: async () => ASSIST_PLAN }) })
    const result = await within((tools.AutofillForm as any).execute({}, {} as any))
    expect(result).toMatchObject({
      filled: [0],
      left: [
        { index: 3, reason: 'low-confidence' },
        { index: 1, reason: 'failed' },
        { index: 2, reason: 'failed' },
      ],
    })
    expect(runControlStep).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['an error reply', async () => ({ error: 'the decision model is not ready' }), 'the decision model is not ready'],
    ['a rejection', async () => { throw new Error('channel closed') }, 'channel closed'],
  ])('turns %s from mapForm into the explicit-fields error, touching nothing', async (_label, mapForm, reason) => {
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks({ mode: () => 'assist', mapForm: mapForm as DeciderHooks['mapForm'] }) })
    expect(await within((tools.AutofillForm as any).execute({}, {} as any))).toEqual({
      error: `Could not map fields automatically (${reason}); pass fields explicitly.`,
    })
    expect(runControlStep).not.toHaveBeenCalled()
  })
})

describe('AutofillForm — assist failures through the real panel hooks (Review Focus 4)', () => {
  const memory = (content: string): MemoryRecord => ({
    id: content, kind: 'profile', content, tags: [], createdAt: 1, updatedAt: 1, lastRecalledAt: null, recallCount: 0, source: 'user',
  })

  beforeEach(() => {
    vi.mocked(snapshotPage).mockReset()
    vi.mocked(runControlStep).mockReset()
    vi.mocked(profileLookup).mockReset()
    vi.mocked(snapshotPage).mockResolvedValue(snap(ASSIST_FORM))
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn(async () => [FG_TAB]) },
      scripting: { executeScript: vi.fn(async () => [{ result: { 1: ['Billing', 'Sales'] } }]) }, // readSelectOptions
    })
  })
  afterEach(() => {
    vi.mocked(getProfileMemories).mockReset()
    vi.mocked(getProfileMemories).mockImplementation(async () => [])
    vi.unstubAllGlobals()
  })

  async function assistHooks() {
    const decide = vi.fn()
    const decider = createDeciderHooks({
      settings: () => ({ mode: 'assist' }),
      conversationId: 'conv-1',
      currentGoal: () => 'fill in the contact form with my details',
      chatModel: () => ({ modelId: 'chat' }) as never,
      engine: { decide, warm: vi.fn(async () => {}) },
      modelReady: async () => true,
    })
    decider.sessionGranted() // RequestPageControl's grant resolves readiness
    await vi.waitFor(() => expect(decider.mode()).toBe('assist'))
    return { decider, decide }
  }

  it('profileLookup throws: the reason comes back in the explicit-fields error, with no fills', async () => {
    vi.mocked(getProfileMemories).mockResolvedValue([memory("The user's full name is Ada Lovelace.")])
    vi.mocked(profileLookup).mockRejectedValue(new Error('HTTP 500 from the chat model'))
    const { decider, decide } = await assistHooks()
    const tools = buildDeciderTools({ session: buildSession(), decider })
    const result = (await within((tools.AutofillForm as any).execute({}, {} as any))) as { error: string }
    expect(result.error).toMatch(/^Could not map fields automatically \(.*HTTP 500 from the chat model.*\); pass fields explicitly\.$/)
    expect(runControlStep).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
  })

  it('zero profile memories and no values: an explicit-fields error, with no model call and no fills', async () => {
    vi.mocked(getProfileMemories).mockResolvedValue([])
    const { decider, decide } = await assistHooks()
    const tools = buildDeciderTools({ session: buildSession(), decider })
    const result = (await within((tools.AutofillForm as any).execute({}, {} as any))) as { error: string }
    expect(result.error).toMatch(/^Could not map fields automatically \(.+\); pass fields explicitly\.$/)
    expect(profileLookup).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
    expect(runControlStep).not.toHaveBeenCalled()
  })
})

describe('AutofillForm — with fields, behaves as before and shadows the call', () => {
  beforeEach(() => {
    vi.mocked(snapshotPage).mockReset()
    vi.mocked(runControlStep).mockReset()
    vi.mocked(snapshotPage).mockResolvedValue(snap(ASSIST_FORM))
    vi.mocked(runControlStep).mockResolvedValue({ ok: true, message: 'typed', registry: 'fresh', origin: 'https://example.com' })
    stubForeground()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const FIELDS = [{ index: 0, value: 'Ada Lovelace' }, { index: 3, value: '+44 20 7946 0958' }]

  it.each(['shadow', 'assist'] as const)('in %s mode: hands the call to observeFill once, never waits for it, and fills as before', async (mode) => {
    const observeFill = vi.fn(() => new Promise<never>(() => {})) as unknown as DeciderHooks['observeFill']
    const mapForm = vi.fn(async () => ASSIST_PLAN)
    const session = buildSession()
    const tools = buildDeciderTools({ session, decider: stubHooks({ mode: () => mode, observeFill, mapForm }) })
    const result = await within((tools.AutofillForm as any).execute({ fields: FIELDS }, {} as any))
    expect(result).toMatchObject({ filled: [0, 3] })
    expect(observeFill).toHaveBeenCalledTimes(1)
    expect(observeFill).toHaveBeenCalledWith({ tabId: 1, snap: expect.objectContaining({ elements: ASSIST_FORM }), session, fields: FIELDS })
    expect(mapForm).not.toHaveBeenCalled() // the model brought its own mapping
    expect(vi.mocked(runControlStep).mock.calls.map(([d]) => d.spec)).toEqual([
      { action: 'type', index: 0, text: 'Ada Lovelace', clear: true, sensitive: undefined },
      { action: 'type', index: 3, text: '+44 20 7946 0958', clear: true, sensitive: undefined },
    ])
  })

  it('reports a field whose action failed as left, not filled', async () => {
    vi.mocked(runControlStep)
      .mockResolvedValueOnce({ ok: true, message: 'typed', registry: 'fresh', origin: 'https://example.com' })
      .mockResolvedValueOnce({ ok: false, message: 'element 3 is no longer on the page', registry: 'fresh', origin: 'https://example.com' })
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks() })
    const result = await within((tools.AutofillForm as any).execute({ fields: FIELDS }, {} as any))
    expect(result).toMatchObject({ filled: [0], left: [{ index: 3, reason: 'failed' }] })
  })

  it('stops typing the rest once the call is aborted', async () => {
    const controller = new AbortController()
    vi.mocked(runControlStep).mockImplementationOnce(async () => {
      controller.abort()
      return { ok: true, message: 'typed', registry: 'fresh', origin: 'https://example.com' }
    })
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks() })
    const result = await within((tools.AutofillForm as any).execute({ fields: FIELDS }, { abortSignal: controller.signal } as any))
    expect(result).toEqual({ filled: [0], error: 'Page control ended while the form was being filled; nothing more was filled.' })
    expect(runControlStep).toHaveBeenCalledTimes(1)
  })

  it('fills as before when observeFill throws', async () => {
    const observeFill = vi.fn(() => {
      throw new Error('decider bug')
    })
    const tools = buildDeciderTools({ session: buildSession(), decider: stubHooks({ observeFill }) })
    const result = await within((tools.AutofillForm as any).execute({ fields: FIELDS }, {} as any))
    expect(result).toMatchObject({ filled: [0, 3] })
    expect(runControlStep).toHaveBeenCalledTimes(2)
  })
})

describe('AutofillForm — its schema and description', () => {
  it('makes fields optional, adds values, and tells the model when it may omit fields', () => {
    const t = buildDeciderTools({ session: buildSession() }).AutofillForm as any
    expect(t.description).toContain(
      'With the decision model in Assist mode you may omit fields and pass the request-specific values; the decider maps the fields.',
    )
    expect(t.inputSchema.safeParse({}).success).toBe(true)
    expect(t.inputSchema.safeParse({ values: { message: 'hello', topic: 'Billing' } }).success).toBe(true)
    expect(t.inputSchema.safeParse({ values: { count: 3 } }).success).toBe(false)
    expect(t.inputSchema.safeParse({ fields: [{ index: 0, value: 'Ada' }] }).success).toBe(true)
  })
})

vi.mock('../platform/webmcp', () => ({ discoverWebMcp: vi.fn(), executeWebMcp: vi.fn() }))
import { discoverWebMcp, executeWebMcp } from '../platform/webmcp'

describe('WebMCP tool approval', () => {
  const action = { name: 'search', handle: 'h-1', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }
  function setup(allow: boolean) {
    const approval = vi.fn(async () => allow)
    vi.mocked(discoverWebMcp).mockResolvedValue({ url: 'https://example.com/', documentId: 'doc-1', revision: 'r-1', tools: [action] })
    vi.mocked(executeWebMcp).mockReset()
    const tools = createAgentTools(approval, 'all-tabs', new Set(), noopPageControl, null, false, [], () => 'always', 'chat', new Set(), undefined, undefined, { resolveTab: async () => ({ id: 7, url: 'https://example.com/' } as chrome.tabs.Tab) })
    return { approval, run: tools.RunWebMcp.execute as any }
  }
  it('requires one-time approval even for an Always policy, then executes against the bound document', async () => {
    const { approval, run } = setup(true)
    await run({ name: 'search', handle: 'h-1', revision: 'r-1', args: { query: 'tea' }, reason: 'Find tea' }, {})
    expect(approval).toHaveBeenCalledWith(expect.objectContaining({ once: true, toolName: 'RunWebMcp' }))
    expect(executeWebMcp).toHaveBeenCalledWith(7, expect.objectContaining({ documentId: 'doc-1' }), action, { query: 'tea' }, { signal: undefined })
  })
  it('does not execute denied actions or arguments that fail the page schema', async () => {
    const { approval, run } = setup(false)
    await run({ name: 'search', handle: 'h-1', revision: 'r-1', args: { query: 'tea' }, reason: 'Find tea' }, {})
    expect(executeWebMcp).not.toHaveBeenCalled()
    approval.mockClear()
    await run({ name: 'search', handle: 'h-1', revision: 'r-1', args: { query: 42 }, reason: 'Find tea' }, {})
    expect(approval).not.toHaveBeenCalled()
    expect(executeWebMcp).not.toHaveBeenCalled()
  })
  it.each([{ handle: 'stale' }, { revision: 'stale' }, { handle: undefined }, { revision: undefined }])('rejects stale or missing discovery identity before approval: %j', async identity => {
    const { approval, run } = setup(true)
    const result = await run({ name: 'search', handle: 'h-1', revision: 'r-1', args: { query: 'tea' }, reason: 'Find tea', ...identity }, {})
    expect(result.error).toBeTruthy()
    expect(approval).not.toHaveBeenCalled()
    expect(executeWebMcp).not.toHaveBeenCalled()
  })
  it('passes cancellation through discovery and execution', async () => {
    const { run } = setup(true)
    const signal = new AbortController().signal
    await run({ name: 'search', handle: 'h-1', revision: 'r-1', args: { query: 'tea' }, reason: 'Find tea' }, { abortSignal: signal })
    expect(discoverWebMcp).toHaveBeenCalledWith(7, false, { signal })
    expect(executeWebMcp).toHaveBeenCalledWith(7, expect.anything(), action, { query: 'tea' }, { signal })
  })
  it('does not execute if Stop is pressed while approval is pending', async () => {
    const { approval, run } = setup(true)
    const controller = new AbortController()
    approval.mockImplementationOnce(async () => { controller.abort(); return true })
    await expect(run({ name: 'search', handle: 'h-1', revision: 'r-1', args: { query: 'tea' }, reason: 'Find tea' }, { abortSignal: controller.signal })).rejects.toThrow()
    expect(executeWebMcp).not.toHaveBeenCalled()
  })
  it('includes preserved title and origin in approval without trusting read-only claims', async () => {
    const { approval, run } = setup(true)
    vi.mocked(discoverWebMcp).mockResolvedValue({ url: 'https://example.com/', documentId: 'doc-1', revision: 'r-1', tools: [{ ...action, title: 'Find tea', origin: 'https://provider.example', annotations: { readOnlyHint: true } }] })
    await run({ name: 'search', handle: 'h-1', revision: 'r-1', args: { query: 'tea' }, reason: 'Find tea' }, {})
    expect(approval).toHaveBeenCalledWith(expect.objectContaining({ once: true, summary: expect.stringContaining('https://provider.example') }))
    expect(approval).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.stringContaining('Find tea (search)') }))
  })
  it('returns a safe failure for schemas the validator cannot resolve', async () => {
    const { approval, run } = setup(true)
    vi.mocked(discoverWebMcp).mockResolvedValue({ url: 'https://example.com/', documentId: 'doc-1', revision: 'r-1', tools: [{ ...action, inputSchema: { $ref: 'https://missing.example/schema' } }] })
    const result = await run({ name: 'search', handle: 'h-1', revision: 'r-1', args: { query: 'tea' }, reason: 'Find tea' }, {})
    expect(result.error).toContain('invalid or unsupported input schema')
    expect(approval).not.toHaveBeenCalled()
    expect(executeWebMcp).not.toHaveBeenCalled()
  })

})

// ---------------------------------------------------------------------------
// FastSteps — driver mode (Task 16): the decision model takes the steps, inside the session,
// with every ControlPage guard. Present ONLY when the settings say Driver.
// ---------------------------------------------------------------------------

const DRIVE_FORM = [
  el({ index: 0, tag: 'input', type: 'search', name: 'Search products' }),
  el({ index: 1, tag: 'button', name: 'Show more' }),
  el({ index: 2, tag: 'button', type: 'submit', name: 'Search' }),
]

type NextFn = DeciderHooks['next']
const top = (op: string, index: number | undefined, p: number) => (index === undefined ? { op, p } : { op, index, p }) as never
const decided = (first: unknown, extra: Record<string, unknown> = {}) => ({ top3: [first, top('scroll', undefined, 0.02), top('done', undefined, 0.01)], tokens: 400, ms: 120, ...extra }) as never

/** A decider that answers each FastSteps step in turn (the last answer repeats). */
function scriptedNext(...answers: unknown[]) {
  let k = 0
  return vi.fn(async () => answers[Math.min(k++, answers.length - 1)]) as unknown as NextFn & ReturnType<typeof vi.fn>
}

function buildDriverTools(opts: {
  session: ControlSession
  next?: NextFn
  mode?: DeciderHooks['settingsMode']
  requestApproval?: ApprovalGate
  policy?: (name: string) => 'always' | 'ask' | 'never'
  activeNames?: Set<string>
  decider?: DeciderHooks
}) {
  const pageControl: PageControlGate = {
    requestSession: async () => true,
    session: () => opts.session,
    endSession: () => {
      opts.session.active = false
    },
  }
  const decider = opts.decider ?? stubHooks({ mode: () => 'driver', settingsMode: opts.mode ?? (() => 'driver'), next: opts.next ?? scriptedNext({ error: 'unused' }) })
  return createAgentTools(
    opts.requestApproval ?? (async () => true),
    'all-tabs',
    new Set(),
    pageControl,
    null,
    false,
    [],
    opts.policy ?? (() => 'always'),
    'conv-1',
    opts.activeNames ?? new Set(),
    undefined,
    undefined,
    { resolveTab: async () => FG_TAB, park: () => {} },
    decider,
  )
}

describe('FastSteps — present only in Driver mode', () => {
  it.each(['off', 'shadow', 'assist'] as const)('is absent from the ToolSet in %s mode, so nothing can surface or resurrect it', (mode) => {
    const tools = buildDriverTools({ session: buildSession(), mode: () => mode })
    expect(tools).not.toHaveProperty('FastSteps')
    expect(tools).toHaveProperty('ControlPage')
  })

  it('is absent without a decider, and when the mode cannot be read', () => {
    expect(buildDeciderTools({ session: buildSession() })).not.toHaveProperty('FastSteps')
    const broken = buildDriverTools({ session: buildSession(), mode: () => { throw new Error('settings gone') } })
    expect(broken).not.toHaveProperty('FastSteps')
  })

  it('is present in Driver mode, with the plan’s description and a goal/values/maxSteps input', async () => {
    const tools = buildDriverTools({ session: buildSession() })
    expect(tools).toHaveProperty('FastSteps')
    expect(tools.FastSteps.description).toBe(
      "Run up to 12 quick page steps toward ONE short sub-goal (e.g. 'search for wireless headphones and open the cheapest result under $100') using the on-device decision model, inside an open page-control session. Pass any values to type in `values`. It hands back when done, unsure, blocked, or after 12 steps; risky steps still ask the user.",
    )
    const schema = (await asSchema(tools.FastSteps.inputSchema).jsonSchema) as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties).sort()).toEqual(['goal', 'maxSteps', 'values'])
    expect(schema.required).toEqual(['goal'])
    // ToolSearch/GetTool can list and load it: the catalog is derived from this ToolSet.
    const listed = await (tools.ToolSearch as any).execute({ query: 'FastSteps' }, {} as any)
    expect(JSON.stringify(listed)).toContain('FastSteps')
  })

  it('a Never policy removes it even in Driver mode', () => {
    expect(buildDriverTools({ session: buildSession(), policy: (n) => (n === 'FastSteps' ? 'never' : 'always') })).not.toHaveProperty('FastSteps')
  })

  it('in the worker realm, the settings alone decide it — no readiness probe there', () => {
    const tools = (settings: unknown) =>
      buildDriverTools({ session: buildSession(), decider: forwardDeciderHooks({ conversationId: 'conv-1', settings: () => settings as never, send: vi.fn() }) })
    expect(tools({ mode: 'driver' })).toHaveProperty('FastSteps')
    expect(tools({ mode: 'assist' })).not.toHaveProperty('FastSteps')
    expect(tools(undefined)).not.toHaveProperty('FastSteps')
  })
})

describe('RequestPageControl — Driver mode loads FastSteps on the grant and says so', () => {
  beforeEach(() => {
    vi.mocked(snapshotPage).mockReset()
    vi.mocked(snapshotPage).mockResolvedValue(snap([el({ index: 0 })]))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds FastSteps to the active set with a note that names it; Assist keeps its own note and adds nothing', async () => {
    stubTabsQuery(FG_TAB)
    const driverNames = new Set<string>()
    const driver: any = await within((buildDriverTools({ session: buildSession(), activeNames: driverNames }).RequestPageControl as any).execute({ plan: 'p' }, {} as any))
    expect(driverNames.has('FastSteps')).toBe(true)
    expect(driver.note).toContain('FastSteps')
    expect(driver.note).toContain('AutofillForm') // Driver includes Assist

    stubTabsQuery(FG_TAB)
    const assistNames = new Set<string>()
    const assist: any = await within(
      (buildDriverTools({ session: buildSession(), activeNames: assistNames, mode: () => 'assist', decider: stubHooks({ mode: () => 'assist', settingsMode: () => 'assist' }) })
        .RequestPageControl as any).execute({ plan: 'p' }, {} as any),
    )
    expect(assistNames.has('FastSteps')).toBe(false)
    expect(assist.note).not.toContain('FastSteps')
    expect(assist.note).toContain('Assist mode is on')
  })
})

describe('FastSteps — the decider drives, every ControlPage guard intact', () => {
  let journalled: ControlSession | null = null
  beforeEach(() => {
    vi.mocked(snapshotPage).mockReset()
    vi.mocked(runControlStep).mockReset()
    let reads = 0
    // Each read differs, so no step looks like a no-change step unless a test says so.
    vi.mocked(snapshotPage).mockImplementation(async () => ({ ...snap(DRIVE_FORM), text: `registry ${reads++}` }))
    vi.mocked(runControlStep).mockImplementation(async (deps) => {
      // Like the real one: a successful step lands in the session's (redacted) journal.
      journalled = deps.session ?? null
      if (deps.session) {
        deps.session.journal = [
          ...(deps.session.journal ?? []),
          { at: 0, action: deps.spec.action, index: deps.spec.index, summary: `${deps.spec.action} ${deps.spec.index ?? ''}`.trim(), undoable: false, sensitive: false, origin: 'https://example.com', url: 'https://example.com/', ...(deps.spec.text ? { redactedValue: deps.spec.text } : {}) },
        ]
      }
      return { ok: true, message: 'done', registry: 'after step', origin: 'https://example.com' }
    })
    stubForeground()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    journalled = null
  })

  it('needs an open session, like ControlPage — and asks the decider nothing without one', async () => {
    const next = scriptedNext(decided(top('click', 1, 0.9)))
    const result = await (buildDriverTools({ session: buildSession({ active: false }), next }).FastSteps as any).execute({ goal: 'g' }, {} as any)
    expect(result).toEqual({ error: 'No page-control session is open. Call RequestPageControl first.' })
    expect(next).not.toHaveBeenCalled()
    expect(runControlStep).not.toHaveBeenCalled()
  })

  it('parks, like ControlPage, when its tab is not in front', async () => {
    vi.stubGlobal('chrome', { tabs: { query: vi.fn(async () => [BG_TAB]) } })
    const next = scriptedNext(decided(top('click', 1, 0.9)))
    const result = await (buildDriverTools({ session: buildSession(), next }).FastSteps as any).execute({ goal: 'g' }, {} as any)
    expect(result).toMatchObject({ parked: true })
    expect(next).not.toHaveBeenCalled()
  })

  it('types the value the panel chose, clicks, and hands back done — quick settle, the steps and the journal reported', async () => {
    const next = scriptedNext(
      decided(top('type', 0, 0.92), { value: { key: 'request.query', text: 'wireless headphones', p: 0.9 } }),
      decided(top('click', 1, 0.81)),
      decided(top('done', undefined, 0.93)),
    )
    const session = buildSession()
    const result: any = await within((buildDriverTools({ session, next }).FastSteps as any).execute({ goal: "search for wireless headphones", values: { query: 'wireless headphones' } }, {} as any))
    expect(vi.mocked(runControlStep).mock.calls.map(([d]) => [d.spec, d.settle])).toEqual([
      [{ action: 'type', index: 0, text: 'wireless headphones', clear: true }, 'quick'],
      [{ action: 'click', index: 1 }, 'quick'],
    ])
    expect(journalled).toBe(session) // it rides the granted session: same journal, same undo
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 1, session, goal: 'search for wireless headphones', values: { query: 'wireless headphones' }, exclude: [] }),
    )
    expect(result).toMatchObject({
      status: 'done',
      reason: 'done',
      steps: [
        { op: 'type', index: 0, p: 0.92, ok: true },
        { op: 'click', index: 1, p: 0.81, ok: true },
      ],
      actions: [
        { action: 'type', index: 0, value: 'wireless headphones' },
        { action: 'click', index: 1 },
      ],
      decisions: 3,
      deciderMs: 360,
    })
    // Two reads per step — the one decided on, and the one re-read right before acting — so the
    // third step's decision read is the fifth.
    expect(result.elements).toBe('registry 4')
    expect(snapshotPage).toHaveBeenCalledTimes(5)
  })

  it('a point of no return asks once (once: true, never "Allow this chat"), then acts with the full settle', async () => {
    const requestApproval = vi.fn<ApprovalGate>(async () => true)
    const next = scriptedNext(decided(top('click', 2, 0.9)), decided(top('done', undefined, 0.9)))
    const result: any = await within((buildDriverTools({ session: buildSession(), next, requestApproval }).FastSteps as any).execute({ goal: "search" }, {} as any))
    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'FastSteps', once: true, summary: 'Click “Search”' }))
    expect(vi.mocked(runControlStep).mock.calls.map(([d]) => [d.spec, d.settle])).toEqual([[{ action: 'click', index: 2 }, 'full']])
    expect(result.status).toBe('done')
  })

  it('a denied point of no return is blocked, and nothing is clicked', async () => {
    const next = scriptedNext(decided(top('click', 2, 0.95)))
    const result = await within((buildDriverTools({ session: buildSession(), next, requestApproval: async () => false }).FastSteps as any).execute({ goal: 'search' }, {} as any))
    expect(result).toMatchObject({ status: 'blocked', reason: 'denied', steps: [] })
    expect(runControlStep).not.toHaveBeenCalled()
  })

  it('a tentative point of no return is handed back with no card at all', async () => {
    const requestApproval = vi.fn<ApprovalGate>(async () => true)
    const next = scriptedNext(decided(top('click', 2, 0.5)))
    const result: any = await within((buildDriverTools({ session: buildSession(), next, requestApproval }).FastSteps as any).execute({ goal: "search" }, {} as any))
    expect(result).toMatchObject({ status: 'handback', reason: 'unsure' })
    expect(requestApproval).not.toHaveBeenCalled()
    expect(runControlStep).not.toHaveBeenCalled()
  })

  it('Stop during a decision acts on nothing', async () => {
    const controller = new AbortController()
    const next = vi.fn(async () => {
      controller.abort()
      return decided(top('click', 1, 0.95))
    }) as unknown as NextFn
    const result = await within((buildDriverTools({ session: buildSession(), next }).FastSteps as any).execute({ goal: 'g' }, { abortSignal: controller.signal }))
    expect(result).toMatchObject({ status: 'stopped', reason: 'stopped' })
    expect(runControlStep).not.toHaveBeenCalled()
  })

  it('a steer stops it at the step boundary', async () => {
    const next = scriptedNext(decided(top('click', 1, 0.9)), decided(top('click', 0, 0.9), { steerPending: true }))
    const result = await within((buildDriverTools({ session: buildSession(), next }).FastSteps as any).execute({ goal: 'g' }, {} as any))
    expect(result).toMatchObject({ status: 'stopped', reason: 'steer' })
    expect(runControlStep).toHaveBeenCalledTimes(1)
  })

  it('a session ended mid-run (the user revoked control) stops before the next step', async () => {
    const session = buildSession()
    const next = vi.fn(async () => {
      session.active = false
      return decided(top('click', 1, 0.9))
    }) as unknown as NextFn
    const result = await within((buildDriverTools({ session, next }).FastSteps as any).execute({ goal: 'g' }, {} as any))
    expect(result).toMatchObject({ status: 'stopped', reason: 'session ended' })
    expect(runControlStep).not.toHaveBeenCalled()
  })

  it('maxSteps is capped at 12', async () => {
    // Alternating targets: an immediate repeat of one would be excluded (spec §3).
    const next = scriptedNext(...Array.from({ length: 13 }, (_, k) => decided(top('click', k % 2 ? 0 : 1, 0.9))))
    const result = await within((buildDriverTools({ session: buildSession(), next }).FastSteps as any).execute({ goal: 'g', maxSteps: 50 }, {} as any), 5000)
    expect(result).toMatchObject({ status: 'handback', reason: 'max steps' })
    expect(runControlStep).toHaveBeenCalledTimes(12)
  })

  it('through the worker realm: each step is a decider.next request to the panel', async () => {
    const requestNext = vi.fn(async (msg: { requestId: string; goal: string; exclude: unknown[] }) => ({ requestId: msg.requestId, top3: [{ op: 'done', p: 0.9 }], tokens: 300, ms: 90 }))
    const decider = forwardDeciderHooks({ conversationId: 'conv-1', settings: () => ({ mode: 'driver' }), send: vi.fn(), requestNext: requestNext as never })
    const result = await within((buildDriverTools({ session: buildSession(), decider }).FastSteps as any).execute({ goal: 'open the cart' }, {} as any))
    expect(result).toMatchObject({ status: 'done', decisions: 1, deciderMs: 90 })
    expect(requestNext).toHaveBeenCalledWith(expect.objectContaining({ type: 'decider.next', goal: 'open the cart', exclude: [] }))
  })
})

describe('FastSteps — fix round 1', () => {
  beforeEach(() => {
    vi.mocked(snapshotPage).mockReset()
    vi.mocked(runControlStep).mockReset()
    let reads = 0
    vi.mocked(snapshotPage).mockImplementation(async () => ({ ...snap(DRIVE_FORM), text: `registry ${reads++}` }))
    vi.mocked(runControlStep).mockResolvedValue({ ok: true, message: 'done', registry: 'after step', origin: 'https://example.com' })
    stubForeground()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a target relabelled between the decision and the act ("Show more" → "Buy now") is never clicked', async () => {
    let reads = 0
    vi.mocked(snapshotPage).mockImplementation(async () =>
      snap(reads++ === 0 ? DRIVE_FORM : DRIVE_FORM.map((e) => (e.index === 1 ? { ...e, name: 'Buy now' } : e))),
    )
    const requestApproval = vi.fn<ApprovalGate>(async () => true)
    const next = scriptedNext(decided(top('click', 1, 0.95)))
    const result: any = await within((buildDriverTools({ session: buildSession(), next, requestApproval }).FastSteps as any).execute({ goal: 'g' }, {} as any))
    expect(result).toMatchObject({ status: 'handback', reason: 'page changed' })
    expect(runControlStep).not.toHaveBeenCalled()
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('a second concurrent run on the same session is refused, and the flag is cleared when the first ends', async () => {
    let release: (v: unknown) => void = () => {}
    let calls = 0
    const first = vi.fn(() => (++calls === 1 ? new Promise((r) => (release = r)) : Promise.resolve(decided(top('done', undefined, 0.9))))) as unknown as NextFn
    const session = buildSession()
    const tools = buildDriverTools({ session, next: first })
    const running = (tools.FastSteps as any).execute({ goal: 'g' }, {} as any)
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1))
    expect(session.driving).toBe(true)
    const second = await within((tools.FastSteps as any).execute({ goal: 'g2' }, {} as any))
    expect(second).toEqual({ status: 'stopped', reason: 'another FastSteps run is in progress' })
    expect(first).toHaveBeenCalledTimes(1) // the refused run asked the decider nothing
    release(decided(top('done', undefined, 0.9)))
    expect(await within(running)).toMatchObject({ status: 'done' })
    expect(session.driving).toBe(false)
    expect(await within((tools.FastSteps as any).execute({ goal: 'g3' }, {} as any))).toMatchObject({ status: 'done' })
  })

  it('the flag is cleared even when the run fails', async () => {
    const session = buildSession()
    const next = vi.fn(async () => {
      throw new Error('boom')
    }) as unknown as NextFn
    const result: any = await within((buildDriverTools({ session, next }).FastSteps as any).execute({ goal: 'g' }, {} as any))
    expect(result.error).toContain('boom')
    expect(session.driving).toBe(false)
  })

  it('the Driver grant note carries the Assist form guidance word for word', async () => {
    vi.mocked(snapshotPage).mockResolvedValue(snap([el({ index: 0 })]))
    stubTabsQuery(FG_TAB)
    const driver: any = await within((buildDriverTools({ session: buildSession() }).RequestPageControl as any).execute({ plan: 'p' }, {} as any))
    stubTabsQuery(FG_TAB)
    const assist: any = await within(
      (buildDriverTools({ session: buildSession(), decider: stubHooks({ mode: () => 'assist', settingsMode: () => 'assist' }) }).RequestPageControl as any).execute({ plan: 'p' }, {} as any),
    )
    const guidance = assist.note.replace('Assist mode is on: ', '')
    expect(guidance).toMatch(/^for a form, call AutofillForm/)
    expect(driver.note.endsWith(guidance)).toBe(true)
  })
})
