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
    threshold: () => 0.6,
    sessionGranted: vi.fn(),
    observeStep: vi.fn(),
    observeFill: vi.fn(),
    mapForm: vi.fn(async () => ({ error: 'unused' })),
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
