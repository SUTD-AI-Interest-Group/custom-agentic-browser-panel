import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from 'ai'

// The one page touch the shadow path makes besides the snapshot it is handed.
vi.mock('../platform/viewportText', () => ({ readViewportText: vi.fn() }))

import { readViewportText } from '../platform/viewportText'
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import type { ControlSession, ControlSpec } from '../tools/pageControl'
import type { ControlJournalEntry } from '../tools/pageControlJournal'
import { MODEL_ID, type DeciderSettings } from './config'
import { createDeciderHooks, deciderRelayListener, latestUserText, type DeciderPanelHooks } from './hooks'
import type { DecisionResult } from './protocol'
import { forwardDeciderHooks, type DecisionStep } from './relay'
import type { DecisionRequest } from './request'
import { clearShadow, listShadow, type ShadowRecord } from './shadowStore'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function el(over: Partial<IndexedElement> & { index: number }): IndexedElement {
  return { tag: 'button', name: `Element ${over.index}`, rect: { x: 0, y: 0, width: 10, height: 10 }, sensitive: false, ...over }
}

function snapOf(elements: IndexedElement[], over: Partial<PageSnapshot> = {}): PageSnapshot {
  return { url: 'https://example.com/form', title: 'Contact form', origin: 'https://example.com', dpr: 1, elements, text: 'registry', truncated: false, ...over }
}

function journal(summaries: string[]): ControlJournalEntry[] {
  return summaries.map((summary, k) => ({
    at: k, action: 'click', summary, undoable: false, sensitive: false, origin: 'https://example.com', url: 'https://example.com/form',
  }))
}

function session(over: Partial<ControlSession> = {}): ControlSession {
  return { tabId: 7, origin: 'https://example.com', plan: 'Fill in the contact form and stop before sending.', active: true, ...over }
}

const FORM = [
  el({ index: 0, tag: 'input', type: 'text', name: 'Full name' }),
  el({ index: 1, tag: 'select', name: 'Topic' }),
  el({ index: 2, tag: 'button', name: 'Send' }),
  el({ index: 3, tag: 'input', type: 'email', name: 'Email' }),
]

/** Answer `next` with `top` at probability `p`, the rest spread evenly over the other options. */
function answering(top: string, p: number) {
  return (options: string[]): number[] => {
    if (!options.includes(top)) throw new Error(`fixture: "${top}" is not an option (${options.join(', ')})`)
    const rest = (1 - p) / (options.length - 1)
    return options.map((o) => (o === top ? p : rest))
  }
}

function fakeEngine(pick: (options: string[]) => number[], extra: Partial<DecisionResult> = {}) {
  const requests: DecisionRequest[] = []
  const engine = {
    warm: vi.fn(async () => {}),
    decide: vi.fn(async (req: DecisionRequest, _opts?: { dropIfBusy?: boolean }): Promise<DecisionResult | null> => {
      requests.push(req)
      const q = req.questions.next as { criteria: Record<string, unknown> }
      const options = Object.keys(q.criteria)
      const probs = pick(options)
      const best = probs.reduce((b, v, i) => (v > probs[b] ? i : b), 0)
      return {
        answers: { next: { kind: 'choice', options, probs, top: options[best], p: probs[best], confidence: 0.5 } },
        ms: 42, tokens: 321, backend: 'webgpu', cold: false, ...extra,
      }
    }),
  }
  return { engine, requests }
}

function hooksWith(o: {
  engine: Pick<ReturnType<typeof fakeEngine>['engine'], 'decide' | 'warm'>
  settings?: DeciderSettings | undefined
  ready?: boolean
  goal?: string
}): DeciderPanelHooks {
  return createDeciderHooks({
    settings: () => ('settings' in o ? o.settings : { mode: 'shadow' }),
    conversationId: 'conv-1',
    currentGoal: () => o.goal ?? 'Fill in the contact form',
    chatModel: () => null,
    engine: o.engine,
    modelReady: async () => o.ready ?? true,
  })
}

/** Drain the fire-and-forget task: wait until the store holds `n` records. */
async function recordsAfter(n: number): Promise<ShadowRecord[]> {
  await vi.waitFor(async () => {
    expect((await listShadow()).length).toBe(n)
  })
  return listShadow()
}

/** Let any pending microtasks / fake-indexeddb ticks run without waiting on a condition. */
const settle = () => new Promise((r) => setTimeout(r, 30))

beforeEach(async () => {
  await clearShadow()
  vi.mocked(readViewportText).mockReset()
  vi.mocked(readViewportText).mockResolvedValue('Contact us. Full name, Topic, Email.')
})
afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// latestUserText — Review Focus 5: a steer changes the goal the decider sees.
// ---------------------------------------------------------------------------

describe('latestUserText', () => {
  it('returns the newest user message for string content', () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'Book a table for two' },
      { role: 'assistant', content: 'On it.' },
      { role: 'user', content: 'Actually, make it four people' }, // a steer spliced mid-chain
      { role: 'assistant', content: [{ type: 'text', text: 'Changing it.' }] },
    ]
    expect(latestUserText(history)).toBe('Actually, make it four people')
  })

  it('returns the text of a parts array of text plus an image', () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'old goal' },
      {
        role: 'user',
        content: [
          { type: 'image', image: 'data:image/png;base64,AAAA' },
          { type: 'text', text: 'Fill this form like the screenshot' },
        ],
      },
    ]
    expect(latestUserText(history)).toBe('Fill this form like the screenshot')
  })

  it('drops the context blocks the panel appends after what the user typed', () => {
    // buildUserTurn (src/ui/Chat.tsx) appends the synced tab content (up to 25k chars on a
    // first message), the on-screen line, a shared selection, @memory and attachment text.
    // None of it is the goal, and the tab content alone would push most steps past the cap.
    const typed = 'Search for wireless headphones and add the cheapest to my cart.'
    const content =
      `${typed}\n\n[Current content of the tab shared with you, synced at send time:]\n<tab title="Store" url="https://shop.test/">\n${'catalog '.repeat(2000)}\n</tab>` +
      `\n\n[Open on screen right now: "Store" (https://shop.test/). This supersedes any earlier "open on screen" line — the user opens, closes and re-splits tabs as the conversation goes on.]` +
      `\n\n[The user invoked @memory — before answering, use the SearchMemory tool …]`
    expect(latestUserText([{ role: 'user', content }])).toBe(typed)
    expect(latestUserText([{ role: 'user', content: `${typed}\n\n--- attached file: notes.txt ---\nhello\n--- end of notes.txt ---` }])).toBe(typed)
    expect(latestUserText([{ role: 'user', content: `${typed}\n\n[The user attached the PDF "a.pdf" (3 pages).]` }])).toBe(typed)
    expect(latestUserText([{ role: 'user', content: `${typed}\n\n[The user highlighted this text on the current page and shared it as context:]\n"""\nx\n"""` }])).toBe(typed)
  })

  it('returns an empty string when there is no user message', () => {
    expect(latestUserText([])).toBe('')
    expect(latestUserText([{ role: 'assistant', content: 'hi' }])).toBe('')
  })
})

// ---------------------------------------------------------------------------
// observeStep — the shadow record
// ---------------------------------------------------------------------------

describe('observeStep', () => {
  it('writes one record that agrees when the decider picks the step the LLM took', async () => {
    const { engine, requests } = fakeEngine(answering('type into [3]', 0.8))
    const hooks = hooksWith({ engine })
    const spec: ControlSpec = { action: 'type', index: 3, text: 'ada@example.com' }
    const ret = hooks.observeStep({ tabId: 7, snap: snapOf(FORM), spec, session: session() })
    expect(ret).toBeUndefined() // fire-and-forget: nothing to await

    const [r] = await recordsAfter(1)
    expect(r).toMatchObject({
      conversationId: 'conv-1',
      seq: 0,
      kind: 'next',
      modelId: MODEL_ID,
      tokens: 321,
      ms: 42,
      backend: 'webgpu',
      cold: false,
      llm: { op: 'type', index: 3 },
      agree: true,
      wouldAct: true, // 0.8 ≥ the default 0.6
    })
    expect(r.skipped).toBeUndefined()
    expect(r.top3).toHaveLength(3)
    expect(r.top3[0]).toEqual({ op: 'type', index: 3, p: 0.8 })
    expect(r.top3[1].p).toBeLessThanOrEqual(0.8)
    expect(engine.decide).toHaveBeenCalledTimes(1)
    expect(engine.decide.mock.calls[0][1]).toEqual({ dropIfBusy: true })
    expect(requests).toHaveLength(1)
  })

  it('builds the request from the goal, plan, page and the last six journal summaries', async () => {
    const { engine, requests } = fakeEngine(answering('click [2]', 0.7))
    const hooks = hooksWith({ engine, goal: 'Send the contact form' })
    const entries = journal(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'])
    hooks.observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'click', index: 2 }, session: session({ journal: entries }) })
    await recordsAfter(1)

    expect(readViewportText).toHaveBeenCalledWith(7, 1200)
    const state = requests[0].state as Record<string, unknown>
    expect(state).toMatchObject({
      goal: 'Send the contact form',
      plan: 'Fill in the contact form and stop before sending.',
      url: 'https://example.com/form',
      title: 'Contact form',
      previous_actions: ['a3', 'a4', 'a5', 'a6', 'a7', 'a8'],
      page_text: 'Contact us. Full name, Topic, Email.',
    })
    const criteria = (requests[0].questions.next as { criteria: Record<string, unknown> }).criteria
    expect(Object.keys(criteria)).toEqual(['type into [0]', 'select in [1]', 'click [2]', 'type into [3]', 'scroll down', 'done'])
  })

  it('reads previous actions at call time, not after the action it is shadowing has run', async () => {
    const { engine, requests } = fakeEngine(answering('click [2]', 0.7))
    const hooks = hooksWith({ engine })
    const entries = journal(['before'])
    hooks.observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'click', index: 2 }, session: session({ journal: entries }) })
    // runControlStep appends this step's own entry right after observeStep returns.
    entries.push(...journal(['the step being shadowed']))
    await recordsAfter(1)
    expect((requests[0].state as Record<string, unknown>).previous_actions).toEqual(['before'])
  })

  it('disagrees on a different index, and on the same index with a different op', async () => {
    const a = fakeEngine(answering('click [2]', 0.9))
    hooksWith({ engine: a.engine }).observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'click', index: 0 }, session: session() })
    const [r1] = await recordsAfter(1)
    expect(r1.agree).toBe(false)
    expect(r1.llm).toEqual({ op: 'click', index: 0 })

    await clearShadow()
    const b = fakeEngine(answering('type into [0]', 0.9))
    hooksWith({ engine: b.engine }).observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'click', index: 0 }, session: session() })
    const [r2] = await recordsAfter(1)
    expect(r2.agree).toBe(false)
  })

  it('leaves actions the decider has no option for unjudged', async () => {
    for (const spec of [
      { action: 'press', keys: 'Enter' },
      { action: 'navigate', url: 'https://example.com/next' },
      { action: 'wait' },
      { action: 'highlight', index: 2, label: 'here' },
      { action: 'scroll', direction: 'up' },
      { action: 'scroll', direction: 'toElement', index: 2 },
    ] as ControlSpec[]) {
      await clearShadow()
      const { engine } = fakeEngine(answering('scroll down', 0.9))
      hooksWith({ engine }).observeStep({ tabId: 7, snap: snapOf(FORM), spec, session: session() })
      const [r] = await recordsAfter(1)
      expect(r.agree, spec.action).toBeNull()
      expect(r.llm?.op).toBe(spec.action)
    }
  })

  it('judges a downward scroll against the decider’s one scroll option', async () => {
    const yes = fakeEngine(answering('scroll down', 0.9))
    hooksWith({ engine: yes.engine }).observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'scroll' }, session: session() })
    const [r1] = await recordsAfter(1)
    expect(r1.agree).toBe(true)
    expect(r1.llm).toEqual({ op: 'scroll' })
    expect(r1.top3[0]).toEqual({ op: 'scroll', p: 0.9 })

    await clearShadow()
    const no = fakeEngine(answering('done', 0.9))
    hooksWith({ engine: no.engine }).observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'scroll', direction: 'down' }, session: session() })
    const [r2] = await recordsAfter(1)
    expect(r2.agree).toBe(false)
    expect(r2.top3[0]).toEqual({ op: 'done', p: 0.9 })
  })

  it('sets wouldAct against the configured threshold', async () => {
    const { engine } = fakeEngine(answering('click [2]', 0.7))
    hooksWith({ engine, settings: { mode: 'shadow', actThreshold: 0.75 } }).observeStep({
      tabId: 7, snap: snapOf(FORM), spec: { action: 'click', index: 2 }, session: session(),
    })
    const [r] = await recordsAfter(1)
    expect(r.wouldAct).toBe(false)
  })

  it('numbers every call of the hooks instance, recorded or not', async () => {
    const { engine } = fakeEngine(answering('click [2]', 0.7))
    let settings: DeciderSettings | undefined = { mode: 'off' }
    const hooks = createDeciderHooks({
      settings: () => settings, conversationId: 'conv-1', currentGoal: () => 'g', chatModel: () => null,
      engine, modelReady: async () => true,
    })
    const step = () => hooks.observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'click', index: 2 }, session: session() })
    step() // seq 0, off: not recorded
    settings = { mode: 'shadow' }
    step() // seq 1
    step() // seq 2
    const rs = await recordsAfter(2)
    expect(rs.map((r) => r.seq).sort()).toEqual([1, 2])
  })

  it('writes nothing when the decision was dropped for a newer one', async () => {
    const engine = { warm: vi.fn(async () => {}), decide: vi.fn(async () => null) }
    hooksWith({ engine }).observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'click', index: 2 }, session: session() })
    await vi.waitFor(() => expect(engine.decide).toHaveBeenCalled())
    await settle()
    expect(await listShadow()).toEqual([])
  })

  it('records a too-long decision as skipped, with the token count the worker reported', async () => {
    const engine = { warm: vi.fn(async () => {}), decide: vi.fn(async () => { throw new Error('too-long: 9000 tokens exceeds 8192') }) }
    hooksWith({ engine }).observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'type', index: 3 }, session: session() })
    const [r] = await recordsAfter(1)
    expect(r).toMatchObject({ skipped: 'too-long', tokens: 9000, agree: null, wouldAct: false, top3: [], llm: { op: 'type', index: 3 }, seq: 0 })
  })

  it('records any other failure as skipped: error — including a failed page-text read', async () => {
    const engine = { warm: vi.fn(async () => {}), decide: vi.fn(async () => { throw new Error('the decider stopped responding and was reset') }) }
    hooksWith({ engine }).observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'click', index: 2 }, session: session() })
    const [r] = await recordsAfter(1)
    expect(r.skipped).toBe('error')
    expect(r.agree).toBeNull()

    await clearShadow()
    vi.mocked(readViewportText).mockRejectedValueOnce(new Error('Cannot access contents of the page'))
    const ok = fakeEngine(answering('click [2]', 0.7))
    hooksWith({ engine: ok.engine }).observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'click', index: 2 }, session: session() })
    const [r2] = await recordsAfter(1)
    expect(r2.skipped).toBe('error')
    expect(ok.engine.decide).not.toHaveBeenCalled()
  })

  it('records an answer it cannot map back to the options as skipped: error', async () => {
    const engine = {
      warm: vi.fn(async () => {}),
      decide: vi.fn(async (): Promise<DecisionResult> => ({ answers: {}, ms: 1, tokens: 1, backend: 'wasm', cold: false })),
    }
    hooksWith({ engine }).observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'click', index: 2 }, session: session() })
    const [r] = await recordsAfter(1)
    expect(r.skipped).toBe('error')
  })

  it('never throws into the caller, whatever its inputs do', async () => {
    const { engine } = fakeEngine(answering('click [2]', 0.7))
    const hooks = createDeciderHooks({
      settings: () => ({ mode: 'shadow' }),
      conversationId: 'c',
      currentGoal: () => { throw new Error('history unavailable') },
      chatModel: () => null,
      engine,
      modelReady: async () => true,
    })
    expect(() => hooks.observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'click', index: 2 }, session: session() })).not.toThrow()
    const throwingSettings = createDeciderHooks({
      settings: () => { throw new Error('boom') },
      conversationId: 'c', currentGoal: () => 'g', chatModel: () => null, engine, modelReady: async () => true,
    })
    expect(() => throwingSettings.observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'click', index: 2 }, session: session() })).not.toThrow()
    expect(throwingSettings.mode()).toBe('off')
    await settle()
  })
})

// ---------------------------------------------------------------------------
// No user data in the record, by construction (the traces.ts rule).
// ---------------------------------------------------------------------------

describe('a ShadowRecord carries no user data', () => {
  it('keeps a typed password, a card number, the host and every element name out of the stored record', async () => {
    const SECRET = 'hunter2-SECRET'
    const elements = [
      el({ index: 0, tag: 'input', type: 'text', name: 'Card 4111 1111 1111 1111', value: '4111 1111 1111 1111', sensitive: true }),
      el({ index: 1, tag: 'input', type: 'password', name: 'Password for ada@example.com', value: SECRET, sensitive: true }),
      el({ index: 2, tag: 'button', name: 'Pay Ada Lovelace now' }),
      el({ index: 3, tag: 'a', name: 'Billing history', href: 'https://example.com/billing' }),
    ]
    const snap = snapOf(elements, { url: 'https://example.com/checkout?card=4111', title: 'Checkout — example.com' })
    const { engine, requests } = fakeEngine(answering('type into [1]', 0.9))
    const hooks = hooksWith({ engine, goal: `Log in with ${SECRET} and pay with card 4111 on example.com` })
    const spec: ControlSpec = {
      action: 'type', index: 1, text: SECRET, value: SECRET, label: `typing ${SECRET}`, url: 'https://example.com/', sensitive: true, clear: true,
    }
    vi.mocked(readViewportText).mockResolvedValue(`Card 4111 1111 1111 1111 — example.com — ${SECRET}`)
    hooks.observeStep({
      tabId: 7,
      snap,
      spec,
      session: session({
        plan: `Pay on example.com with card 4111 using ${SECRET}`,
        journal: journal([`typed into "Card 4111 1111 1111 1111"`, `typed ${SECRET}`]),
        undoState: new Map([[1, { value: SECRET, kind: 'type' as const }]]),
      }),
    })
    const [r] = await recordsAfter(1)
    // Sanity: the secrets really did flow through the capture path (to the on-device model only).
    expect(JSON.stringify(requests[0])).toContain(SECRET)

    const stored = JSON.stringify(r)
    for (const needle of ['hunter2', '4111', 'example.com', 'Ada', 'Lovelace', 'Billing', 'Password', 'Card', 'Pay ', 'Checkout']) {
      expect(stored, needle).not.toContain(needle)
    }
    for (const e of elements) expect(stored).not.toContain(e.name)
    expect(r.agree).toBe(true)
  })

  it('holds on the forwarded path too: worker → runtime message → panel → record', async () => {
    const SECRET = 'hunter2-SECRET'
    const elements = [
      el({ index: 0, tag: 'input', type: 'text', name: 'Card 4111 1111 1111 1111', value: '4111 1111 1111 1111', sensitive: true }),
      el({ index: 1, tag: 'input', type: 'password', name: 'Password for ada@example.com', value: SECRET, sensitive: true }),
      el({ index: 2, tag: 'button', name: 'Pay Ada Lovelace now' }),
    ]
    const { engine, requests } = fakeEngine(answering('type into [1]', 0.9))
    const panel = createDeciderHooks({
      settings: () => ({ mode: 'shadow' }),
      conversationId: 'conv-1',
      currentGoal: () => `Log in with ${SECRET} on example.com`,
      chatModel: () => null,
      engine,
      modelReady: async () => true,
    })
    const wire: unknown[] = []
    // The worker's hooks, with chrome.runtime.sendMessage's JSON round trip standing in for the channel.
    const worker = forwardDeciderHooks({
      conversationId: 'conv-1',
      settings: () => ({ mode: 'shadow' }),
      send: (msg) => {
        const sent = JSON.parse(JSON.stringify(msg))
        wire.push(sent)
        panel.relay(sent)
      },
    })
    vi.mocked(readViewportText).mockResolvedValue(`Card 4111 — example.com — ${SECRET}`)
    worker.observeStep({
      tabId: 7,
      snap: snapOf(elements, { url: 'https://example.com/checkout?card=4111', title: 'Checkout — example.com' }),
      spec: { action: 'type', index: 1, text: SECRET, value: SECRET, label: SECRET, url: 'https://example.com/', sensitive: true },
      session: session({ plan: `Pay on example.com using ${SECRET}`, journal: journal([`typed into "Card 4111 1111 1111 1111"`]) }),
    })
    const [r] = await recordsAfter(1)
    expect(r).toMatchObject({ conversationId: 'conv-1', seq: 0, llm: { op: 'type', index: 1 }, agree: true, backend: 'webgpu', ms: 42 })

    // What crossed the channel carries no typed value and no field value of a sensitive element…
    expect(wire).toHaveLength(1)
    expect(JSON.stringify(wire)).not.toContain(`"${SECRET}"`)
    expect(JSON.stringify((wire[0] as { step: { spec: unknown } }).step.spec)).toBe('{"action":"type","index":1}')
    // …the decision still saw the page (names, goal, plan — on-device only)…
    expect(JSON.stringify(requests[0])).toContain('Password for ada@example.com')
    // …and the stored record carries none of it.
    const stored = JSON.stringify(r)
    for (const needle of ['hunter2', '4111', 'example.com', 'Ada', 'Lovelace', 'Password', 'Card', 'Checkout']) {
      expect(stored, needle).not.toContain(needle)
    }
    for (const e of elements) expect(stored).not.toContain(e.name)
  })
})

// ---------------------------------------------------------------------------
// relay() — the panel end of the worker's forwarding hooks
// ---------------------------------------------------------------------------

describe('relay()', () => {
  const step = (over: Partial<DecisionStep> = {}): DecisionStep => ({
    tabId: 7, url: 'https://example.com/form', title: 'Contact form', plan: 'Fill it', previousActions: [],
    elements: FORM.map(({ index, tag, type, name, sensitive }) => ({ index, tag, type, name, sensitive })),
    spec: { action: 'click', index: 2 },
    pageText: 'Read by the worker before the click.',
    ...over,
  })

  it('shadows a relayed step for its own conversation, numbering every relayed step of the chain', async () => {
    const { engine, requests } = fakeEngine(answering('click [2]', 0.9))
    const hooks = hooksWith({ engine, goal: 'Send it' })
    hooks.relay({ type: 'decider.step', conversationId: 'conv-1', step: step() })
    hooks.relay({ type: 'decider.step', conversationId: 'conv-1', step: step({ spec: { action: 'type', index: 0 } }) })
    const rs = await recordsAfter(2)
    expect(rs.map((r) => r.seq).sort()).toEqual([0, 1])
    expect(rs.find((r) => r.seq === 0)).toMatchObject({ llm: { op: 'click', index: 2 }, agree: true })
    expect(rs.find((r) => r.seq === 1)).toMatchObject({ llm: { op: 'type', index: 0 }, agree: false })
    expect((requests[0].state as Record<string, unknown>).goal).toBe('Send it')
  })

  it('decides on the page text the worker read before the action — the panel never re-reads it', async () => {
    const { engine, requests } = fakeEngine(answering('click [2]', 0.9))
    const hooks = hooksWith({ engine })
    hooks.relay({ type: 'decider.step', conversationId: 'conv-1', step: step() })
    await recordsAfter(1)
    expect((requests[0].state as Record<string, unknown>).page_text).toBe('Read by the worker before the click.')
    // A panel-side read would land after the worker had already moved on to the action.
    expect(readViewportText).not.toHaveBeenCalled()
  })

  it('records a worker-side page-text failure as skipped: error, without deciding or re-reading', async () => {
    const { engine } = fakeEngine(answering('click [2]', 0.9))
    const hooks = hooksWith({ engine })
    hooks.relay({ type: 'decider.step', conversationId: 'conv-1', step: step({ pageText: null }) })
    const [r] = await recordsAfter(1)
    expect(r).toMatchObject({ skipped: 'error', seq: 0, llm: { op: 'click', index: 2 } })
    expect(engine.decide).not.toHaveBeenCalled()
    expect(readViewportText).not.toHaveBeenCalled()
  })

  it('ignores other conversations and anything malformed, without throwing', async () => {
    const { engine } = fakeEngine(answering('click [2]', 0.9))
    const hooks = hooksWith({ engine })
    for (const msg of [
      { type: 'decider.step', conversationId: 'someone-else', step: step() },
      { type: 'decider.step', conversationId: 'conv-1', step: { ...step(), tabId: 'seven' } },
      { type: 'chat.control.journal', conversationId: 'conv-1' },
      null,
      'decider.step',
    ]) {
      expect(() => hooks.relay(msg)).not.toThrow()
    }
    await settle()
    expect(engine.decide).not.toHaveBeenCalled()
    expect(await listShadow()).toEqual([])
    // Ignored messages take no sequence number: the next real step is still 0.
    hooks.relay({ type: 'decider.step', conversationId: 'conv-1', step: step() })
    const [r] = await recordsAfter(1)
    expect(r.seq).toBe(0)
  })

  it('warms the engine on a relayed grant for its conversation only', async () => {
    const { engine } = fakeEngine(answering('done', 1))
    const hooks = hooksWith({ engine })
    hooks.relay({ type: 'decider.granted', conversationId: 'someone-else' })
    await settle()
    expect(engine.warm).not.toHaveBeenCalled()
    hooks.relay({ type: 'decider.granted', conversationId: 'conv-1' })
    await vi.waitFor(() => expect(engine.warm).toHaveBeenCalledTimes(1))
  })
})

// ---------------------------------------------------------------------------
// deciderRelayListener — what runTurnChain registers on chrome.runtime.onMessage
// ---------------------------------------------------------------------------

describe('deciderRelayListener', () => {
  const EXT = 'lychee-ext-id'
  const at = (path: string) => `chrome-extension://${EXT}/${path}`
  const msg = (conversationId = 'conv-1') => ({
    type: 'decider.step',
    conversationId,
    step: {
      tabId: 7, url: 'https://example.com/form', title: 'Contact form', plan: 'Fill it', previousActions: [],
      elements: [{ index: 2, tag: 'button', name: 'Send', sensitive: false }],
      spec: { action: 'click', index: 2 },
      pageText: 'text',
    },
  })

  beforeEach(() => {
    vi.stubGlobal('chrome', { runtime: { id: EXT, getURL: at } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hands a step from this extension’s service worker, for this conversation, to the hooks', async () => {
    const { engine } = fakeEngine(answering('click [2]', 0.9))
    const listener = deciderRelayListener(hooksWith({ engine }), 'conv-1')
    expect(listener(msg(), { id: EXT, url: at('background.js') })).toBeUndefined() // never holds the channel open
    const [r] = await recordsAfter(1)
    expect(r).toMatchObject({ conversationId: 'conv-1', llm: { op: 'click', index: 2 }, agree: true })
  })

  it.each([
    ['another extension page (the panel, offscreen, a tab)', { id: EXT, url: at('sidepanel.html') }],
    ['the offscreen document', { id: EXT, url: at('offscreen.html') }],
    ['a foreign extension', { id: 'some-other-extension', url: 'chrome-extension://some-other-extension/background.js' }],
    ['a foreign extension claiming our worker URL', { id: 'some-other-extension', url: at('background.js') }],
    ['a content script', { id: EXT, url: 'https://example.com/form', tab: { id: 7 } }],
    ['no sender details', {}],
  ])('rejects a step sent by %s', async (_label, sender) => {
    const { engine } = fakeEngine(answering('click [2]', 0.9))
    const hooks = hooksWith({ engine })
    const relay = vi.spyOn(hooks, 'relay')
    deciderRelayListener(hooks, 'conv-1')(msg(), sender as chrome.runtime.MessageSender)
    await settle()
    expect(relay).not.toHaveBeenCalled()
    expect(engine.decide).not.toHaveBeenCalled()
    expect(await listShadow()).toEqual([])
  })

  it("ignores another conversation's step, even from the right sender", async () => {
    const { engine } = fakeEngine(answering('click [2]', 0.9))
    const hooks = hooksWith({ engine })
    const relay = vi.spyOn(hooks, 'relay')
    deciderRelayListener(hooks, 'conv-1')(msg('conv-2'), { id: EXT, url: at('background.js') })
    await settle()
    expect(relay).not.toHaveBeenCalled()
    expect(engine.decide).not.toHaveBeenCalled()
  })

  it('never throws, whatever arrives', () => {
    const listener = deciderRelayListener(hooksWith({ engine: fakeEngine(answering('done', 1)).engine }), 'conv-1')
    for (const m of [null, undefined, 'x', 42, { type: 'decider.step' }, { conversationId: 'conv-1' }]) {
      expect(() => listener(m, { id: EXT, url: at('background.js') })).not.toThrow()
    }
    vi.unstubAllGlobals()
    vi.stubGlobal('chrome', undefined)
    expect(() => listener(msg(), { id: EXT, url: at('background.js') })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

describe('mode()', () => {
  it("returns 'off' while the model isn't ready, even with settings.mode = 'shadow'", async () => {
    const { engine } = fakeEngine(answering('click [2]', 0.9))
    const modelReady = vi.fn(async () => false)
    const hooks = createDeciderHooks({
      settings: () => ({ mode: 'shadow' }), conversationId: 'c', currentGoal: () => 'g', chatModel: () => null, engine, modelReady,
    })
    expect(hooks.mode()).toBe('off') // unresolved: off until proven ready
    await settle()
    expect(hooks.mode()).toBe('off')
    hooks.observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'click', index: 2 }, session: session() })
    hooks.sessionGranted()
    await settle()
    expect(engine.decide).not.toHaveBeenCalled()
    expect(engine.warm).not.toHaveBeenCalled()
    expect(readViewportText).not.toHaveBeenCalled()
    expect(await listShadow()).toEqual([])
    expect(modelReady).toHaveBeenCalledTimes(1) // cached for the chain
  })

  it("returns the setting's mode once the model is ready, and 'off' when the settings say so", async () => {
    let settings: DeciderSettings | undefined = { mode: 'shadow' }
    const modelReady = vi.fn(async () => true)
    const hooks = createDeciderHooks({
      settings: () => settings, conversationId: 'c', currentGoal: () => 'g', chatModel: () => null,
      engine: fakeEngine(answering('done', 1)).engine, modelReady,
    })
    hooks.sessionGranted() // resolves readiness
    await settle()
    expect(hooks.mode()).toBe('shadow')
    settings = { mode: 'assist' }
    expect(hooks.mode()).toBe('assist')
    settings = { mode: 'off' }
    expect(hooks.mode()).toBe('off')
    settings = undefined
    expect(hooks.mode()).toBe('off')
    expect(modelReady).toHaveBeenCalledTimes(1)
  })

  it('treats a readiness probe that throws as not ready', async () => {
    const hooks = createDeciderHooks({
      settings: () => ({ mode: 'shadow' }), conversationId: 'c', currentGoal: () => 'g', chatModel: () => null,
      engine: fakeEngine(answering('done', 1)).engine,
      modelReady: () => { throw new Error('storage gone') },
    })
    expect(hooks.mode()).toBe('off')
    await settle()
    expect(hooks.mode()).toBe('off')
  })

  it('threshold() is the setting, else the default', () => {
    const engine = fakeEngine(answering('done', 1)).engine
    expect(hooksWith({ engine, settings: { mode: 'shadow', actThreshold: 0.8 } }).threshold()).toBe(0.8)
    expect(hooksWith({ engine, settings: { mode: 'shadow' } }).threshold()).toBe(0.6)
    expect(hooksWith({ engine, settings: undefined }).threshold()).toBe(0.6)
  })
})

describe('sessionGranted()', () => {
  it('warms the engine once the model is ready, without being awaited', async () => {
    const { engine } = fakeEngine(answering('done', 1))
    const hooks = hooksWith({ engine })
    expect(hooks.sessionGranted()).toBeUndefined()
    await vi.waitFor(() => expect(engine.warm).toHaveBeenCalledTimes(1))
  })

  it('does not warm when the decider is off', async () => {
    const { engine } = fakeEngine(answering('done', 1))
    hooksWith({ engine, settings: { mode: 'off' } }).sessionGranted()
    hooksWith({ engine, settings: undefined }).sessionGranted()
    await settle()
    expect(engine.warm).not.toHaveBeenCalled()
  })

  it('swallows a failed warm-up', async () => {
    const engine = { warm: vi.fn(async () => { throw new Error('the decider did not start in time') }), decide: vi.fn() }
    hooksWith({ engine }).sessionGranted()
    await vi.waitFor(() => expect(engine.warm).toHaveBeenCalled())
    await settle() // an unhandled rejection here fails the run
  })
})

describe('Task 11 stubs', () => {
  it('observeFill is a no-op and mapForm reports assist as unavailable', async () => {
    const { engine } = fakeEngine(answering('done', 1))
    const hooks = hooksWith({ engine })
    expect(hooks.observeFill({ tabId: 7, snap: snapOf(FORM), session: session(), fields: [{ index: 0, value: 'Ada' }] })).toBeUndefined()
    expect(await hooks.mapForm({ tabId: 7, snap: snapOf(FORM), session: session(), values: {} })).toEqual({
      error: 'assist mode is not implemented yet',
    })
    await settle()
    expect(engine.decide).not.toHaveBeenCalled()
  })
})
