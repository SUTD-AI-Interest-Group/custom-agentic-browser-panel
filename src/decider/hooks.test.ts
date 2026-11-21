import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LanguageModel, ModelMessage } from 'ai'

// The one page touch the shadow path makes besides the snapshot it is handed.
vi.mock('../platform/viewportText', () => ({ readViewportText: vi.fn() }))
// The fill path's page touch (select options), its memory read, and its one chat-model call.
vi.mock('../platform/domIndex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/domIndex')>()),
  readSelectOptions: vi.fn(async () => ({})),
}))
vi.mock('../data/memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data/memory')>()),
  getProfileMemories: vi.fn(async () => []),
}))
vi.mock('./profileLookup', () => ({ profileLookup: vi.fn() }))

import { readViewportText } from '../platform/viewportText'
import { readSelectOptions } from '../platform/domIndex'
import { getProfileMemories, type MemoryRecord } from '../data/memory'
import { profileLookup } from './profileLookup'
import type { FillPlan } from './fillPlan'
import type { Answer } from './readout'
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

/** Resolves with the value, or rejects after `ms` — so a hang fails fast instead of timing out the file. */
function within<T>(p: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))])
}

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

  it('builds the request from the goal, plan, page and the last ten previous actions', async () => {
    const { engine, requests } = fakeEngine(answering('click [2]', 0.7))
    const hooks = hooksWith({ engine, goal: 'Send the contact form' })
    const entries = journal(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'])
    hooks.observeStep({ tabId: 7, snap: snapOf(FORM), spec: { action: 'click', index: 2 }, session: session({ journal: entries }) })
    await recordsAfter(1)

    expect(readViewportText).toHaveBeenCalledWith(7, 1200)
    const state = requests[0].state as Record<string, unknown>
    expect(state).toMatchObject({
      goal: 'Send the contact form',
      plan: 'Fill in the contact form and stop before sending.',
      url: 'https://example.com/form',
      title: 'Contact form',
      previous_actions: ['a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'],
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

// ---------------------------------------------------------------------------
// Form filling: mapForm (assist) and observeFill (shadowing the chat model's own mapping)
// ---------------------------------------------------------------------------

const FILL_FORM = [
  el({ index: 0, tag: 'input', type: 'text', name: 'Full name' }),
  el({ index: 1, tag: 'input', type: 'email', name: 'Email address' }),
  el({ index: 2, tag: 'select', name: 'Topic' }),
  el({ index: 3, tag: 'textarea', name: 'How can we help?' }),
  el({ index: 4, tag: 'input', type: 'checkbox', name: 'I agree to be contacted', checked: false }),
  el({ index: 5, tag: 'input', type: 'password', name: 'Password', value: 'hunter2', sensitive: true }),
  el({ index: 6, tag: 'button', type: 'submit', name: 'Send message' }),
]
const TOPICS = { 2: ['Billing', 'Technical support', 'Sales'] }
const PROFILE = { full_name: 'Ada Lovelace', email: 'ada@example.com', work_email: 'ada@analytical-engines.co.uk' }
const VALUES = { message: 'My last invoice was charged twice.' }
const MEMORIES: MemoryRecord[] = ["The user's full name is Ada Lovelace.", "The user's email address is ada@example.com."].map((content, k) => ({
  id: `m${k}`, kind: 'profile', content, tags: [], createdAt: 1, updatedAt: 1, lastRecalledAt: null, recallCount: 0, source: 'user',
}))
/** Everything a fill record must never contain: values typed or chosen, option labels, field names, the host. */
const FILL_SECRETS = ['Ada', 'Lovelace', 'ada@', 'analytical', 'invoice', 'Billing', 'Sales', 'hunter2', 'Full name', 'Topic', 'example.com', 'Password']

/** An engine that answers every fill question: `picks[name] = [top, p]` (the rest share 1 − p). */
function fillEngine(picks: Record<string, [string, number]>, extra: Partial<DecisionResult> = {}) {
  const requests: DecisionRequest[] = []
  const engine = {
    warm: vi.fn(async () => {}),
    decide: vi.fn(async (req: DecisionRequest, _opts?: { dropIfBusy?: boolean }): Promise<DecisionResult | null> => {
      requests.push(req)
      const answers: Record<string, Answer> = {}
      for (const [name, q] of Object.entries(req.questions)) {
        const options = q.type === 'noul' ? ['false', 'true'] : Object.keys(q.criteria as Record<string, unknown>)
        const [top, p] = picks[name] ?? [options[0], 1 / options.length]
        if (!options.includes(top)) throw new Error(`fixture: "${top}" is not an option of ${name} (${options.join(', ')})`)
        const probs = options.map((o) => (o === top ? p : (1 - p) / (options.length - 1)))
        const a: Answer = { kind: q.type === 'noul' ? 'noul' : 'choice', options, probs, top, p, confidence: 0.5 }
        if (q.type === 'noul') a.yes = probs[options.indexOf('true')]
        answers[name] = a
      }
      return { answers, ms: 55, tokens: 640, backend: 'webgpu', cold: false, ...extra }
    }),
  }
  return { engine, requests }
}

const ASSIST_PICKS: Record<string, [string, number]> = {
  f0: ['profile.full_name', 0.9],
  f1: ['profile.email', 0.85],
  f2: ['Billing', 0.95],
  f3: ['request.message', 0.8],
  f4: ['true', 0.9],
}

const CHAT_MODEL = { modelId: 'chat' } as unknown as LanguageModel

function fillHooks(o: { engine: ReturnType<typeof fillEngine>['engine']; mode?: DeciderSettings['mode']; ready?: boolean; chatModel?: LanguageModel | null }) {
  return createDeciderHooks({
    settings: () => ({ mode: o.mode ?? 'assist' }),
    conversationId: 'conv-1',
    currentGoal: () => 'Fill in the contact form with my details and tick the consent box',
    chatModel: () => ('chatModel' in o ? (o.chatModel ?? null) : CHAT_MODEL),
    engine: o.engine,
    modelReady: async () => o.ready ?? true,
  })
}

describe('form filling', () => {
  beforeEach(() => {
    vi.mocked(readSelectOptions).mockReset()
    vi.mocked(readSelectOptions).mockResolvedValue(TOPICS)
    vi.mocked(getProfileMemories).mockReset()
    vi.mocked(getProfileMemories).mockResolvedValue(MEMORIES)
    vi.mocked(profileLookup).mockReset()
    vi.mocked(profileLookup).mockResolvedValue({ ...PROFILE })
  })

  describe('mapForm (assist)', () => {
    it('plans the fill from the profile and the request values, and records key names only', async () => {
      const { engine, requests } = fillEngine(ASSIST_PICKS)
      const plan = await fillHooks({ engine }).mapForm({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), values: VALUES })

      expect(plan).toEqual<FillPlan>({
        fills: [
          { index: 0, kind: 'text', key: 'profile.full_name', value: 'Ada Lovelace', p: 0.9 },
          { index: 1, kind: 'text', key: 'profile.email', value: 'ada@example.com', p: 0.85 },
          { index: 2, kind: 'select', key: 'Billing', value: 'Billing', p: 0.95 },
          { index: 3, kind: 'text', key: 'request.message', value: VALUES.message, p: 0.8 },
          { index: 4, kind: 'checkbox', key: 'tick', value: 'tick', p: expect.closeTo(0.9, 6) },
        ],
        left: [],
      })
      // The select options were read for the select, the profile structured by the chat model…
      expect(readSelectOptions).toHaveBeenCalledWith(7, [2])
      expect(profileLookup).toHaveBeenCalledWith(CHAT_MODEL, MEMORIES)
      // …and the decision was queued, NOT dropIfBusy: this one is being waited on.
      expect(engine.decide).toHaveBeenCalledTimes(1)
      expect(engine.decide.mock.calls[0][1]?.dropIfBusy).toBeFalsy()
      const state = requests[0].state as Record<string, unknown>
      expect(state.goal).toBe('Fill in the contact form with my details and tick the consent box')
      expect(state.info).toEqual({ profile: PROFILE, request: VALUES })
      // The password field and the submit button are never fill questions.
      expect(Object.keys(requests[0].questions).sort()).toEqual(['f0', 'f1', 'f2', 'f3', 'f4'])

      const [r] = await recordsAfter(1)
      expect(r).toMatchObject({
        conversationId: 'conv-1', seq: 0, kind: 'fill', modelId: MODEL_ID, tokens: 640, ms: 55, backend: 'webgpu', cold: false,
        llm: null, agree: null, wouldAct: true,
      })
      expect(r.fill).toEqual([
        { index: 0, key: 'profile.full_name', p: 0.9, llmAgrees: null },
        { index: 1, key: 'profile.email', p: 0.85, llmAgrees: null },
        { index: 2, key: 'option.0', p: 0.95, llmAgrees: null }, // an option's position, never its label
        { index: 3, key: 'request.0', p: 0.8, llmAgrees: null }, // a request value's position: its name is the chat model's free text
        { index: 4, key: 'tick', p: 0.9, llmAgrees: null },
      ])
      // top3 = the weakest fields: the record's confidence is its least sure field.
      expect(r.top3).toEqual([
        { op: 'fill', index: 3, p: 0.8 },
        { op: 'fill', index: 1, p: 0.85 },
        { op: 'fill', index: 0, p: 0.9 },
      ])
      const stored = JSON.stringify(r)
      for (const needle of FILL_SECRETS) expect(stored, needle).not.toContain(needle)
    })

    it('records a request value by its position: the name the chat model chose never reaches the store', async () => {
      const values = { topic: 'Billing', 'note that my card is 4111 1111 1111 1111': 'My last invoice was charged twice.' }
      const { engine } = fillEngine({ f3: ['request.note that my card is 4111 1111 1111 1111', 0.9] })
      const plan = (await fillHooks({ engine }).mapForm({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), values })) as FillPlan
      // The plan keeps the real name — AutofillForm's `mapped` reports it back to the model that chose it…
      expect(plan.fills).toContainEqual({ index: 3, kind: 'text', key: 'request.note that my card is 4111 1111 1111 1111', value: values['note that my card is 4111 1111 1111 1111'], p: 0.9 })
      // …but the stored record holds only its position among the request's values.
      const [r] = await recordsAfter(1)
      expect(r.fill?.find((f) => f.index === 3)?.key).toBe('request.1')
      expect(JSON.stringify(r)).not.toContain('4111')
      expect(JSON.stringify(r)).not.toContain('note that')
    })

    it('leaves fields under the threshold, and wouldAct is false when nothing would be filled', async () => {
      const { engine } = fillEngine({ f0: ['profile.full_name', 0.4], f1: ['leave_empty', 0.9], f2: ['Billing', 0.3], f3: ['request.message', 0.5], f4: ['false', 0.9] })
      const plan = await fillHooks({ engine }).mapForm({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), values: VALUES })
      expect(plan).toEqual({
        fills: [],
        left: [
          { index: 0, reason: 'low-confidence' },
          { index: 1, reason: 'leave-empty' },
          { index: 2, reason: 'low-confidence' },
          { index: 3, reason: 'low-confidence' },
          { index: 4, reason: 'leave-empty' }, // p(no) 0.9: a confident "leave it unticked"
        ],
      })
      const [r] = await recordsAfter(1)
      expect(r.wouldAct).toBe(false)
      expect(r.fill?.find((f) => f.index === 4)?.key).toBe('leave')
    })

    it.each([
      ['shadow mode', { mode: 'shadow' as const }, 'not in Assist mode'],
      ['off', { mode: 'off' as const }, 'not in Assist mode'],
      ['a model that is not ready', { ready: false }, 'not ready'],
    ])('answers an error for %s, deciding nothing', async (_label, over, reason) => {
      const { engine } = fillEngine(ASSIST_PICKS)
      const out = await fillHooks({ engine, ...over }).mapForm({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), values: VALUES })
      expect(out).toEqual({ error: expect.stringContaining(reason) })
      expect(engine.decide).not.toHaveBeenCalled()
      expect(profileLookup).not.toHaveBeenCalled()
    })

    it('zero profile memories and no values: an error, with no model call at all', async () => {
      vi.mocked(getProfileMemories).mockResolvedValue([])
      const { engine } = fillEngine(ASSIST_PICKS)
      const out = await fillHooks({ engine }).mapForm({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), values: {} })
      expect(out).toEqual({ error: 'no saved profile details and no values to fill from' })
      expect(profileLookup).not.toHaveBeenCalled()
      expect(engine.decide).not.toHaveBeenCalled()
    })

    it('zero profile memories but some values: fills from the values alone', async () => {
      vi.mocked(getProfileMemories).mockResolvedValue([])
      const { engine, requests } = fillEngine({ f3: ['request.message', 0.9] })
      const out = (await fillHooks({ engine }).mapForm({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), values: VALUES })) as FillPlan
      expect(profileLookup).not.toHaveBeenCalled()
      expect((requests[0].state as { info: unknown }).info).toEqual({ profile: {}, request: VALUES })
      expect(out.fills).toContainEqual({ index: 3, kind: 'text', key: 'request.message', value: VALUES.message, p: 0.9 })
    })

    it('a profile lookup that throws becomes the error reason', async () => {
      vi.mocked(profileLookup).mockRejectedValue(new Error('HTTP 500'))
      const { engine } = fillEngine(ASSIST_PICKS)
      const out = await fillHooks({ engine }).mapForm({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), values: VALUES })
      expect(out).toEqual({ error: 'could not read the profile: HTTP 500' })
      expect(engine.decide).not.toHaveBeenCalled()
    })

    it('no chat model to read the profile with is an error', async () => {
      const { engine } = fillEngine(ASSIST_PICKS)
      const out = await fillHooks({ engine, chatModel: null }).mapForm({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), values: VALUES })
      expect(out).toEqual({ error: expect.stringContaining('chat model') })
      expect(engine.decide).not.toHaveBeenCalled()
    })

    it('a page with nothing to fill is an error', async () => {
      const { engine } = fillEngine(ASSIST_PICKS)
      const out = await fillHooks({ engine }).mapForm({ tabId: 7, snap: snapOf([FILL_FORM[5], FILL_FORM[6]]), session: session(), values: VALUES })
      expect(out).toEqual({ error: 'no fillable fields on this page' })
      expect(engine.decide).not.toHaveBeenCalled()
    })

    it('a failed decision is an error, and a skipped record', async () => {
      const engine = { warm: vi.fn(async () => {}), decide: vi.fn(async () => { throw new Error('too-long: 9100 tokens exceeds 8192') }) }
      const out = await fillHooks({ engine } as never).mapForm({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), values: VALUES })
      expect(out).toEqual({ error: expect.stringContaining('too long') })
      const [r] = await recordsAfter(1)
      expect(r).toMatchObject({ kind: 'fill', skipped: 'too-long', tokens: 9100, llm: null })
    })

    it('an abort ends the wait at once, and a plan that arrives after it is neither returned nor recorded', async () => {
      let answer: (r: DecisionResult) => void = () => {}
      const { engine: picks } = fillEngine(ASSIST_PICKS)
      const engine = { warm: vi.fn(async () => {}), decide: vi.fn((req: DecisionRequest) => new Promise<DecisionResult>((r) => { answer = r; void req })) }
      const controller = new AbortController()
      const out = fillHooks({ engine } as never).mapForm({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), values: VALUES, signal: controller.signal })
      await vi.waitFor(() => expect(engine.decide).toHaveBeenCalledTimes(1))
      controller.abort()
      expect(await within(out)).toEqual({ error: 'the turn was stopped' })
      answer((await picks.decide(engine.decide.mock.calls[0][0]))!) // the decision lands afterwards
      await settle()
      expect(await listShadow()).toEqual([])
    })
  })

  describe('observeFill (shadow)', () => {
    const LLM_FIELDS = [
      { index: 0, value: 'Ada Lovelace' }, // = the decider's profile.full_name → agrees
      { index: 1, value: 'ada@analytical-engines.co.uk' }, // the decider chose profile.email → disagrees
      { index: 2, value: 'billing' }, // the decider chose Billing → agrees (case-insensitive)
      { index: 3, value: 'My last invoice was charged twice.' }, // not a value the decider could choose → unjudged
      { index: 4, value: 'true' }, // ticked, as the decider would → agrees
      { index: 5, value: 'hunter2', sensitive: true }, // never compared, never stored
    ]
    const SHADOW_PICKS: Record<string, [string, number]> = { ...ASSIST_PICKS, f3: ['leave_empty', 0.7] }

    it('returns at once and records, per field, whether the decider would have typed the same value', async () => {
      const { engine, requests } = fillEngine(SHADOW_PICKS)
      const hooks = fillHooks({ engine, mode: 'shadow' })
      expect(hooks.observeFill({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), fields: LLM_FIELDS })).toBeUndefined()
      const [r] = await recordsAfter(1)
      expect(r).toMatchObject({ kind: 'fill', seq: 0, llm: { op: 'fill' }, agree: false, wouldAct: true })
      expect(r.fill).toEqual([
        { index: 0, key: 'profile.full_name', p: 0.9, llmAgrees: true },
        { index: 1, key: 'profile.email', p: 0.85, llmAgrees: false },
        { index: 2, key: 'option.0', p: 0.95, llmAgrees: true },
        { index: 3, key: 'leave_empty', p: 0.7, llmAgrees: null },
        { index: 4, key: 'tick', p: 0.9, llmAgrees: true },
      ])
      // The shadow decides from the profile alone: what the model typed is never offered back to it.
      expect((requests[0].state as { info: unknown }).info).toEqual({ profile: PROFILE, request: {} })
      expect(JSON.stringify(requests[0])).not.toContain('hunter2')
      const stored = JSON.stringify(r)
      for (const needle of FILL_SECRETS) expect(stored, needle).not.toContain(needle)
    })

    it('asks the engine with dropIfBusy, like a step, and records nothing when a newer decision supersedes it', async () => {
      const { engine } = fillEngine(SHADOW_PICKS)
      fillHooks({ engine, mode: 'shadow' }).observeFill({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), fields: LLM_FIELDS })
      await recordsAfter(1)
      expect(engine.decide.mock.calls[0][1]).toEqual({ dropIfBusy: true })

      await clearShadow()
      const dropped = { warm: vi.fn(async () => {}), decide: vi.fn(async () => null) }
      fillHooks({ engine: dropped as never, mode: 'shadow' }).observeFill({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), fields: LLM_FIELDS })
      await vi.waitFor(() => expect(dropped.decide).toHaveBeenCalledTimes(1))
      await settle()
      expect(await listShadow()).toEqual([])
    })

    it('agrees overall when every judged field agrees', async () => {
      const { engine } = fillEngine(SHADOW_PICKS)
      fillHooks({ engine, mode: 'assist' }).observeFill({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), fields: [LLM_FIELDS[0], LLM_FIELDS[2]] })
      const [r] = await recordsAfter(1)
      expect(r.agree).toBe(true)
      expect(r.fill?.filter((f) => f.llmAgrees !== null).map((f) => f.index)).toEqual([0, 2])
    })

    it('records nothing, and asks no model, when the decider is off, not ready, or there is no profile', async () => {
      for (const over of [{ mode: 'off' as const }, { ready: false }]) {
        const { engine } = fillEngine(SHADOW_PICKS)
        fillHooks({ engine, mode: 'shadow', ...over }).observeFill({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), fields: LLM_FIELDS })
        await settle()
        expect(engine.decide).not.toHaveBeenCalled()
      }
      vi.mocked(getProfileMemories).mockResolvedValue([])
      const { engine } = fillEngine(SHADOW_PICKS)
      fillHooks({ engine, mode: 'shadow' }).observeFill({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), fields: LLM_FIELDS })
      await settle()
      expect(engine.decide).not.toHaveBeenCalled()
      expect(profileLookup).not.toHaveBeenCalled()
      expect(await listShadow()).toEqual([])
    })

    it('never throws into the caller, whatever its inputs do', async () => {
      vi.mocked(profileLookup).mockRejectedValue(new Error('HTTP 500'))
      const { engine } = fillEngine(SHADOW_PICKS)
      const hooks = fillHooks({ engine, mode: 'shadow' })
      expect(() => hooks.observeFill({ tabId: 7, snap: snapOf(FILL_FORM), session: session(), fields: LLM_FIELDS })).not.toThrow()
      expect(() => hooks.observeFill(null as never)).not.toThrow()
      await settle() // an unhandled rejection here fails the run
      expect(engine.decide).not.toHaveBeenCalled()
    })
  })

  describe('across the channel', () => {
    const elements = FILL_FORM.map(({ index, tag, type, name, checked, sensitive }) => ({
      index, tag, name, sensitive, ...(type ? { type } : {}), ...(checked !== undefined ? { checked } : {}),
    }))
    const mapFormMsg = (over: Record<string, unknown> = {}) => ({
      type: 'decider.mapForm', conversationId: 'conv-1', requestId: 'req-1', tabId: 7,
      snap: { url: 'https://example.com/form', title: 'Contact form', elements },
      plan: 'Fill the form', selectOptions: TOPICS, values: VALUES, ...over,
    })

    it('answer(): replies the plan for its own conversation, from the options the worker read', async () => {
      const { engine } = fillEngine(ASSIST_PICKS)
      const reply = await fillHooks({ engine }).answer(mapFormMsg())
      expect(reply).toMatchObject({ requestId: 'req-1', plan: { fills: expect.any(Array), left: [] } })
      expect((reply as { plan: FillPlan }).plan.fills.map((f) => f.index)).toEqual([0, 1, 2, 3, 4])
      expect(readSelectOptions).not.toHaveBeenCalled() // the worker already read them, before anything changed
      await recordsAfter(1)
    })

    it('a cancel from the worker (it gave up waiting) drops the pending plan: no plan in the reply, no fill record', async () => {
      let answer: (r: DecisionResult) => void = () => {}
      const { engine: picks } = fillEngine(ASSIST_PICKS)
      const engine = { warm: vi.fn(async () => {}), decide: vi.fn((req: DecisionRequest) => new Promise<DecisionResult>((r) => { answer = r; void req })) }
      const hooks = fillHooks({ engine } as never)
      const reply = hooks.answer(mapFormMsg())!
      await vi.waitFor(() => expect(engine.decide).toHaveBeenCalledTimes(1))
      hooks.relay({ type: 'decider.mapForm.cancel', conversationId: 'someone-else', requestId: 'req-1' }) // not ours: ignored
      hooks.relay({ type: 'decider.mapForm.cancel', conversationId: 'conv-1', requestId: 'req-other' }) // not this request
      hooks.relay({ type: 'decider.mapForm.cancel', conversationId: 'conv-1', requestId: 'req-1' })
      answer((await picks.decide(engine.decide.mock.calls[0][0]))!)
      expect(await reply).toEqual({ requestId: 'req-1', error: 'the request was cancelled' })
      await settle()
      expect(await listShadow()).toEqual([]) // assist stats never count a plan that was never applied
    })

    it('a cancel that lands while the profile is still being read stops before deciding', async () => {
      let lookedUp: (p: Record<string, string>) => void = () => {}
      vi.mocked(profileLookup).mockReturnValue(new Promise((r) => (lookedUp = r)))
      const { engine } = fillEngine(ASSIST_PICKS)
      const hooks = fillHooks({ engine })
      const reply = hooks.answer(mapFormMsg())!
      await vi.waitFor(() => expect(profileLookup).toHaveBeenCalledTimes(1))
      hooks.relay({ type: 'decider.mapForm.cancel', conversationId: 'conv-1', requestId: 'req-1' })
      lookedUp({ ...PROFILE })
      expect(await reply).toEqual({ requestId: 'req-1', error: 'the request was cancelled' })
      expect(engine.decide).not.toHaveBeenCalled()
    })

    it('answer(): replies the error with its requestId', async () => {
      const { engine } = fillEngine(ASSIST_PICKS)
      expect(await fillHooks({ engine, mode: 'shadow' }).answer(mapFormMsg())).toEqual({ requestId: 'req-1', error: expect.stringContaining('Assist') })
    })

    it('answer(): ignores another conversation and anything malformed', async () => {
      const { engine } = fillEngine(ASSIST_PICKS)
      const hooks = fillHooks({ engine })
      for (const msg of [
        mapFormMsg({ conversationId: 'someone-else' }),
        mapFormMsg({ requestId: '' }),
        mapFormMsg({ tabId: 'seven' }),
        mapFormMsg({ values: { message: 42 } }),
        mapFormMsg({ selectOptions: { 2: 'Billing' } }),
        { type: 'decider.step', conversationId: 'conv-1' },
        null,
      ]) {
        expect(hooks.answer(msg)).toBeUndefined()
      }
      await settle()
      expect(engine.decide).not.toHaveBeenCalled()
    })

    it('relay(): a forwarded fill observation is shadowed with the options the worker read', async () => {
      const { engine } = fillEngine(SHADOW_PICKS_FOR_RELAY)
      const hooks = fillHooks({ engine, mode: 'shadow' })
      hooks.relay({
        type: 'decider.fill', conversationId: 'conv-1',
        fill: { tabId: 7, snap: { url: 'https://example.com/form', title: 'Contact form', elements }, plan: 'Fill', selectOptions: TOPICS, fields: [{ index: 0, value: 'Ada Lovelace' }] },
      })
      const [r] = await recordsAfter(1)
      expect(r).toMatchObject({ kind: 'fill', llm: { op: 'fill' }, agree: true })
      expect(readSelectOptions).not.toHaveBeenCalled()
    })

    describe('deciderRelayListener', () => {
      const EXT = 'lychee-ext-id'
      const at = (path: string) => `chrome-extension://${EXT}/${path}`
      beforeEach(() => {
        vi.stubGlobal('chrome', { runtime: { id: EXT, getURL: at } })
      })
      afterEach(() => {
        vi.unstubAllGlobals()
      })

      it('holds the channel open for a mapForm request from our worker and answers through sendResponse', async () => {
        const { engine } = fillEngine(ASSIST_PICKS)
        const sendResponse = vi.fn()
        const listener = deciderRelayListener(fillHooks({ engine }), 'conv-1')
        expect(listener(mapFormMsg(), { id: EXT, url: at('background.js') }, sendResponse)).toBe(true)
        await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1))
        expect(sendResponse.mock.calls[0][0]).toMatchObject({ requestId: 'req-1', plan: { fills: expect.any(Array) } })
      })

      it.each([
        ['another of our pages', { id: EXT, url: at('sidepanel.html') }],
        ['a foreign extension', { id: 'other', url: at('background.js') }],
        ['a content script', { id: EXT, url: 'https://example.com/form', tab: { id: 7 } }],
      ])('ignores a mapForm request from %s, without holding the channel', async (_label, sender) => {
        const { engine } = fillEngine(ASSIST_PICKS)
        const sendResponse = vi.fn()
        expect(deciderRelayListener(fillHooks({ engine }), 'conv-1')(mapFormMsg(), sender as chrome.runtime.MessageSender, sendResponse)).toBeUndefined()
        await settle()
        expect(sendResponse).not.toHaveBeenCalled()
        expect(engine.decide).not.toHaveBeenCalled()
      })

      it('passes a cancel from our worker to the hooks without holding the channel', async () => {
        const { engine } = fillEngine(ASSIST_PICKS)
        const hooks = fillHooks({ engine })
        const relay = vi.spyOn(hooks, 'relay')
        const cancel = { type: 'decider.mapForm.cancel', conversationId: 'conv-1', requestId: 'req-1' }
        expect(deciderRelayListener(hooks, 'conv-1')(cancel, { id: EXT, url: at('background.js') }, vi.fn())).toBeUndefined()
        expect(relay).toHaveBeenCalledWith(cancel)
      })

      it("ignores another conversation's request, so that conversation's own chain can answer it", () => {
        const { engine } = fillEngine(ASSIST_PICKS)
        const sendResponse = vi.fn()
        const listener = deciderRelayListener(fillHooks({ engine }), 'conv-1')
        expect(listener(mapFormMsg({ conversationId: 'conv-2' }), { id: EXT, url: at('background.js') }, sendResponse)).toBeUndefined()
        expect(sendResponse).not.toHaveBeenCalled()
      })
    })
  })
})

const SHADOW_PICKS_FOR_RELAY: Record<string, [string, number]> = { f0: ['profile.full_name', 0.9] }
