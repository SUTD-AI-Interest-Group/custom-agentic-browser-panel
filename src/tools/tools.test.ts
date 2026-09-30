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

import { createAgentTools, scrubActValues, type ApprovalGate, type PageControlGate, type PageTarget } from './tools'
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

  it('marks the origin-drift early return as drifted', async () => {
    // The tab has already moved to a different origin than the session
    // remembers, and the session records that its previous step's approved
    // point-of-no-return authorized the crossing — so this re-fences
    // silently (no approval card) and returns the fresh page without ever
    // reaching runControlStep.
    const driftedTab = { id: 1, windowId: 1, url: 'https://b.example/' } as chrome.tabs.Tab
    stubTabsQuery(driftedTab) // entry-point isForeground check inside controlStep
    vi.mocked(snapshotPage).mockResolvedValue(snap([el({ index: 0, name: 'Continue' })], 'https://b.example'))

    const session = buildSession({ origin: 'https://a.example', crossingAuthorized: true })
    const pageControl: PageControlGate = {
      requestSession: async () => true,
      session: () => session,
      endSession: () => {
        session.active = false
      },
    }
    const pageTarget: PageTarget = { resolveTab: async () => driftedTab, park: () => {} }
    const tools = createAgentTools(
      async () => true,
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

    const result = (await (tools.ControlPage as any).execute(
      { action: 'click', index: 0 },
      {} as any,
    )) as any

    expect(result.drifted).toBe(true)
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
// Act (System-1) — built only with a runtime, drives controlStep, never echoes
// the caller's values, and stops between steps once the chain is aborted.
// ---------------------------------------------------------------------------

describe('Act (System-1)', () => {
  function buildWith(system1?: { decide: any }) {
    return createAgentTools(async () => true, 'all-tabs', new Set(), noopPageControl, null, false, [],
      () => 'always', 'conv-1', new Set(), undefined, undefined, undefined, system1 ? { warm: vi.fn(), ...system1 } as any : undefined)
  }

  function buildInSession(
    decide: (req: any) => Promise<any>,
    opts: { activeNames?: Set<string>; tab?: chrome.tabs.Tab; session?: ControlSession; requestApproval?: ApprovalGate; warm?: () => void } = {},
  ) {
    const session = opts.session ?? buildSession()
    const pageControl: PageControlGate = {
      requestSession: async () => true,
      session: () => session,
      endSession: () => { session.active = false },
    }
    const pageTarget: PageTarget = { resolveTab: async () => opts.tab ?? FG_TAB, park: () => {} }
    return createAgentTools(opts.requestApproval ?? (async () => true), 'all-tabs', new Set(), pageControl, null, false, [],
      () => 'always', 'conv-1', opts.activeNames ?? new Set(), undefined, undefined, pageTarget, { decide, warm: opts.warm ?? vi.fn() })
  }

  const answer = (key: string, choice: string, top = 0.9) =>
    ({ answers: { [key]: { choice, probabilities: { [choice]: top }, top, confidence: top } }, ms: 1 })

  beforeEach(() => {
    vi.mocked(snapshotPage).mockReset()
    vi.mocked(runControlStep).mockReset()
    vi.stubGlobal('chrome', { tabs: { query: vi.fn(async () => [FG_TAB]) } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is absent without a System-1 runtime', () => {
    expect(buildWith().Act).toBeUndefined()
  })

  it('is absent when ControlPage is set to Never — no side door around the policy', () => {
    const tools = createAgentTools(async () => true, 'all-tabs', new Set(), noopPageControl, null, false, [],
      (n) => (n === 'ControlPage' ? 'never' : 'always'), 'conv-1', new Set(), undefined, undefined, undefined,
      { decide: vi.fn() } as any)
    expect(tools.ControlPage).toBeUndefined()
    expect(tools.Act).toBeUndefined()
  })

  it('is absent when Act itself is set to Never', () => {
    const tools = createAgentTools(async () => true, 'all-tabs', new Set(), noopPageControl, null, false, [],
      (n) => (n === 'Act' ? 'never' : 'always'), 'conv-1', new Set(), undefined, undefined, undefined,
      { decide: vi.fn() } as any)
    expect(tools.ControlPage).toBeDefined()
    expect(tools.Act).toBeUndefined()
  })

  it('is present with one, and refuses without a page-control session', async () => {
    const tools = buildWith({ decide: vi.fn() })
    expect(tools.Act).toBeDefined()
    const r = (await (tools.Act as any).execute({ goal: 'x' }, { toolCallId: 't', messages: [] })) as any
    expect(r.error).toMatch(/RequestPageControl/)
  })

  it('rejects a non-integer or over-cap maxSteps and an empty or oversized goal at the schema', () => {
    const schema = (buildWith({ decide: vi.fn() }).Act as any).inputSchema
    expect(schema.safeParse({ goal: 'x', maxSteps: 3 }).success).toBe(true)
    expect(schema.safeParse({ goal: 'x', maxSteps: 2.5 }).success).toBe(false)
    expect(schema.safeParse({ goal: 'x', maxSteps: 9 }).success).toBe(false)
    expect(schema.safeParse({ goal: 'x', maxSteps: 0 }).success).toBe(false)
    expect(schema.safeParse({ goal: '' }).success).toBe(false)
    expect(schema.safeParse({ goal: 'x'.repeat(301) }).success).toBe(false)
  })

  it('types a supplied value through controlStep but scrubs it from everything the page reflects back', async () => {
    const SECRET = 'secret@example.com'
    // Live-page behaviour: once the value is typed, the registry renders the
    // field's current value, and an unlabeled field's name falls back to it.
    let typed = false
    vi.mocked(snapshotPage).mockImplementation(async () => typed
      ? { ...snap([
          el({ index: 0, tag: 'input', type: 'email', name: 'Email', value: SECRET }),
          el({ index: 1, tag: 'input', type: 'text', name: SECRET }),
        ]), text: `[0] email "Email" value="${SECRET}"\n[1] text "${SECRET}"` }
      : snap([el({ index: 0, tag: 'input', type: 'email', name: 'Email' })]))
    vi.mocked(runControlStep).mockImplementation(async () => {
      typed = true
      return { ok: true, message: 'typed', registry: `[0] email "Email" value="${SECRET}"`, origin: 'https://example.com' }
    })
    const decide = vi.fn()
      .mockResolvedValueOnce(answer('operation', 'TYPE_TEXT'))
      .mockResolvedValueOnce(answer('target_TYPE_TEXT', '0'))
      .mockResolvedValueOnce(answer('value', 'email'))
      .mockResolvedValueOnce(answer('operation', 'TYPE_TEXT'))
      // Target below ACT_TRY_CONFIDENCE → `uncertain`, which returns candidates + elements.
      .mockResolvedValueOnce({ answers: { target_TYPE_TEXT: { choice: '1', probabilities: { '1': 0.35, '0': 0.3 }, top: 0.35, confidence: 0.1 } }, ms: 1 })
    const tools = buildInSession(decide)
    const r = (await (tools.Act as any).execute(
      { goal: 'fill the email', values: { email: SECRET } },
      { toolCallId: 't', messages: [] },
    )) as any
    expect(r.status).toBe('uncertain')
    expect(r.steps).toHaveLength(1)
    expect(vi.mocked(runControlStep).mock.calls[0][0].spec).toMatchObject({ action: 'type', index: 0, text: SECRET })
    expect(r.elements).toContain('«email»')
    expect(r.candidates.map((c: any) => c.label)).toContain('«email»')
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('scrubs long values literally but never touches short values or [N] index tokens', () => {
    const result = {
      status: 'uncertain',
      steps: [{ action: 'type', index: 12, label: 'Email a@b.co' }],
      message: 'typed a@b.co into [12]',
      elements: '[12] email "Email" = "a@b.co"\n[2] number "Qty" = "2"\n[20] button "Add 2"',
      candidates: [{ index: 12, label: 'a@b.co', p: 0.4 }],
    } as any
    const r = scrubActValues(result, { qty: '2', email: 'a@b.co' })
    expect(r.elements).toBe('[12] email "Email" = "«email»"\n[2] number "Qty" = "2"\n[20] button "Add 2"')
    expect(r.message).toBe('typed «email» into [12]')
    expect(r.steps[0].label).toBe('Email «email»')
    expect(r.candidates![0].label).toBe('«email»')
    expect(JSON.stringify(r)).not.toContain('a@b.co')
  })

  it('does not rewrite an index token even when a long value matches its digits', () => {
    const r = scrubActValues({ status: 'done', steps: [], elements: '[1234] text "code 1234"' } as any, { pin: '1234' })
    expect(r.elements).toBe('[1234] text "code «pin»"')
  })

  describe('maps every controlStep outcome to an Act status', () => {
    const clickFirst = () => vi.fn()
      .mockResolvedValueOnce(answer('operation', 'CLICK'))
      .mockResolvedValueOnce(answer('target_CLICK', '0'))
      .mockResolvedValue(answer('operation', 'DONE'))
    const run = (tools: any) => (tools.Act as any).execute({ goal: 'click it' }, { toolCallId: 't', messages: [] })

    it('denied — the point-of-no-return card is refused', async () => {
      vi.mocked(snapshotPage).mockResolvedValue(snap([el({ index: 0, type: 'submit', name: 'Place order' })]))
      const r = await run(buildInSession(clickFirst(), { requestApproval: async () => false }))
      expect(r.status).toBe('denied')
      expect(runControlStep).not.toHaveBeenCalled()
    })

    it('parked — the user switched away mid-loop', async () => {
      vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValueOnce([FG_TAB]).mockResolvedValue([BG_TAB]) } })
      vi.mocked(snapshotPage).mockResolvedValue(snap([el({ index: 0, name: 'Next' })]))
      const r = await run(buildInSession(clickFirst()))
      expect(r.status).toBe('parked')
      expect(runControlStep).not.toHaveBeenCalled()
    })

    it('drifted — wins over the ok:true the drift branch also carries', async () => {
      const drifted = { id: 1, windowId: 1, url: 'https://b.example/' } as chrome.tabs.Tab
      vi.stubGlobal('chrome', { tabs: { query: vi.fn(async () => [drifted]) } })
      vi.mocked(snapshotPage).mockResolvedValue(snap([el({ index: 0, name: 'Next' })]))
      const r = await run(buildInSession(clickFirst(), { tab: drifted, session: buildSession({ crossingAuthorized: true }) }))
      expect(r.status).toBe('drifted')
      expect(runControlStep).not.toHaveBeenCalled()
    })

    it('error — controlStep returns an error string', async () => {
      vi.mocked(snapshotPage)
        .mockResolvedValueOnce(snap([el({ index: 0, name: 'Next' })])) // the loop's own read
        .mockRejectedValue(new Error('gone')) // controlStep's read
      const r = await run(buildInSession(clickFirst()))
      expect(r.status).toBe('error')
      expect(r.message).toMatch(/Cannot read this page/)
    })

    it('error — runControlStep reports ok:false', async () => {
      vi.mocked(snapshotPage).mockResolvedValue(snap([el({ index: 0, name: 'Next' })]))
      vi.mocked(runControlStep).mockResolvedValue({ ok: false, message: 'element vanished', registry: 'fresh', origin: 'https://example.com' })
      const r = await run(buildInSession(clickFirst()))
      expect(r.status).toBe('error')
      expect(r.message).toBe('element vanished')
    })

    it('ok — a successful step is recorded and the loop continues', async () => {
      vi.mocked(snapshotPage).mockResolvedValue(snap([el({ index: 0, name: 'Next' })]))
      vi.mocked(runControlStep).mockResolvedValue({ ok: true, message: 'clicked', registry: 'fresh', origin: 'https://example.com' })
      const r = await run(buildInSession(clickFirst()))
      expect(r.status).toBe('done')
      expect(r.steps).toHaveLength(1)
    })
  })

  it('parks before reading the page when the controlled tab is not in front', async () => {
    vi.stubGlobal('chrome', { tabs: { query: vi.fn(async () => [BG_TAB]) } })
    const decide = vi.fn()
    const r = (await (buildInSession(decide).Act as any).execute({ goal: 'x' }, { toolCallId: 't', messages: [] })) as any
    expect(r.parked).toBe(true)
    expect(snapshotPage).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
  })

  it('stops between steps once the tool call is aborted', async () => {
    vi.mocked(snapshotPage).mockResolvedValue(snap([el({ index: 0, name: 'Next' })]))
    vi.mocked(runControlStep).mockResolvedValue({ ok: true, message: 'scrolled', registry: 'fresh', origin: 'https://example.com' })
    const ctrl = new AbortController()
    const decide = vi.fn(async () => {
      ctrl.abort() // Stop pressed while the first step is being decided
      return answer('operation', 'SCROLL_DOWN')
    })
    const tools = buildInSession(decide)
    const r = (await (tools.Act as any).execute(
      { goal: 'find the next button' },
      { toolCallId: 't', messages: [], abortSignal: ctrl.signal },
    )) as any
    expect(r.status).toBe('aborted')
    expect(r.steps).toHaveLength(1)
    expect(decide).toHaveBeenCalledTimes(1)
  })

  it('joins the control cluster when RequestPageControl is granted, only with a runtime', async () => {
    vi.mocked(snapshotPage).mockRejectedValue(new Error('stop here'))
    const withRuntime = new Set<string>()
    const warm = vi.fn()
    await (buildInSession(vi.fn(), { activeNames: withRuntime, warm }).RequestPageControl as any).execute({ plan: 'p' }, { toolCallId: 't', messages: [] })
    expect(withRuntime.has('ControlPage')).toBe(true)
    expect(withRuntime.has('Act')).toBe(true)
    // The grant is the moment to boot the local model, not the first Act call.
    expect(warm).toHaveBeenCalledTimes(1)

    const without = new Set<string>()
    const session = buildSession()
    const tools = createAgentTools(async () => true, 'all-tabs', new Set(),
      { requestSession: async () => true, session: () => session, endSession: () => {} },
      null, false, [], () => 'always', 'conv-1', without, undefined, undefined,
      { resolveTab: async () => FG_TAB, park: () => {} })
    await (tools.RequestPageControl as any).execute({ plan: 'p' }, { toolCallId: 't', messages: [] })
    expect(without.has('ControlPage')).toBe(true)
    expect(without.has('Act')).toBe(false)
  })
})
