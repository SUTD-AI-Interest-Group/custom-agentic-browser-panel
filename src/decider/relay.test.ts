import { describe, expect, it, vi } from 'vitest'
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import type { ControlSession, ControlSpec } from '../tools/pageControl'
import type { ControlJournalEntry } from '../tools/pageControlJournal'
import type { DeciderSettings } from './config'
import { forwardDeciderHooks, parseDeciderRelay, SENSITIVE_VALUE_MASK, stepOf, type DeciderRelayMsg, type DecisionStep } from './relay'

function el(over: Partial<IndexedElement> & { index: number }): IndexedElement {
  return { tag: 'button', name: `Element ${over.index}`, rect: { x: 1, y: 2, width: 3, height: 4 }, sensitive: false, ...over }
}
const snap = (elements: IndexedElement[]): PageSnapshot => ({
  url: 'https://shop.test/checkout', title: 'Checkout', origin: 'https://shop.test', dpr: 2, elements, text: 'registry text', truncated: false,
})
const journal = (summaries: string[]): ControlJournalEntry[] =>
  summaries.map((summary, k) => ({ at: k, action: 'click', summary, undoable: false, sensitive: false, origin: 'o', url: 'u', redactedValue: 'rv', label: 'lbl' }))
const session = (over: Partial<ControlSession> = {}): ControlSession => ({ tabId: 7, origin: 'https://shop.test', plan: 'Check out', active: true, ...over })

const STEP: DecisionStep = {
  tabId: 7,
  url: 'https://shop.test/checkout',
  title: 'Checkout',
  plan: 'Check out',
  previousActions: ['clicked "Cart"'],
  elements: [{ index: 0, tag: 'input', type: 'email', name: 'Email', value: 'a@b.c', sensitive: false }],
  spec: { action: 'type', index: 0 },
}

describe('stepOf', () => {
  it('carries only what a decision needs', () => {
    const spec: ControlSpec = { action: 'type', index: 1, text: 'typed-text', value: 'v', url: 'https://x.test', label: 'lbl', keys: 'Enter', clear: true, sensitive: true, timeoutMs: 5 }
    const step = stepOf({
      tabId: 7,
      snap: snap([
        el({ index: 0, tag: 'a', name: 'Home', href: 'https://shop.test/', formMethod: 'get', ancestorName: 'nav', role: 'link' }),
        el({ index: 1, tag: 'input', type: 'password', name: 'Password', value: 'hunter2', sensitive: true }),
        el({ index: 2, tag: 'input', type: 'checkbox', name: 'Agree', checked: true }),
      ]),
      spec,
      session: session({ journal: journal(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']), undoState: new Map([[1, { value: 'old', kind: 'type' }]]) }),
    })
    expect(step).toEqual({
      tabId: 7,
      url: 'https://shop.test/checkout',
      title: 'Checkout',
      plan: 'Check out',
      previousActions: ['a2', 'a3', 'a4', 'a5', 'a6', 'a7'],
      elements: [
        { index: 0, tag: 'a', role: 'link', name: 'Home', sensitive: false },
        { index: 1, tag: 'input', type: 'password', name: 'Password', value: SENSITIVE_VALUE_MASK, sensitive: true },
        { index: 2, tag: 'input', type: 'checkbox', name: 'Agree', checked: true, sensitive: false },
      ],
      spec: { action: 'type', index: 1 },
    })
    expect(JSON.stringify(step)).not.toContain('hunter2')
    expect(JSON.stringify(step)).not.toContain('typed-text')
  })
})

describe('parseDeciderRelay', () => {
  it('accepts a granted message and a well-formed step', () => {
    expect(parseDeciderRelay({ type: 'decider.granted', conversationId: 'c' })).toEqual({ type: 'decider.granted', conversationId: 'c' })
    expect(parseDeciderRelay({ type: 'decider.step', conversationId: 'c', step: STEP })).toEqual({ type: 'decider.step', conversationId: 'c', step: STEP })
  })

  it('survives the JSON round trip chrome.runtime.sendMessage makes', () => {
    const msg: DeciderRelayMsg = { type: 'decider.step', conversationId: 'c', step: { ...STEP, spec: { action: 'scroll', direction: 'down' } } }
    expect(parseDeciderRelay(JSON.parse(JSON.stringify(msg)))).toEqual(msg)
  })

  it('rebuilds field by field: anything extra is dropped, a sensitive value is masked again', () => {
    const parsed = parseDeciderRelay({
      type: 'decider.step',
      conversationId: 'c',
      extra: 'x',
      step: {
        ...STEP,
        spec: { action: 'type', index: 0, text: 'typed-text' },
        elements: [{ index: 0, tag: 'input', name: 'Pin', value: '1234', sensitive: true, rect: { x: 0 }, href: 'h' }],
        snapshot: 'raw',
      },
    })
    expect(parsed).toEqual({
      type: 'decider.step',
      conversationId: 'c',
      step: { ...STEP, spec: { action: 'type', index: 0 }, elements: [{ index: 0, tag: 'input', name: 'Pin', value: SENSITIVE_VALUE_MASK, sensitive: true }] },
    })
  })

  it.each([
    ['not an object', 'decider.step'],
    ['null', null],
    ['unknown type', { type: 'decider.other', conversationId: 'c' }],
    ['no conversationId', { type: 'decider.granted' }],
    ['empty conversationId', { type: 'decider.granted', conversationId: '' }],
    ['no step', { type: 'decider.step', conversationId: 'c' }],
    ['fractional tabId', { type: 'decider.step', conversationId: 'c', step: { ...STEP, tabId: 1.5 } }],
    ['url not a string', { type: 'decider.step', conversationId: 'c', step: { ...STEP, url: 3 } }],
    ['previousActions not strings', { type: 'decider.step', conversationId: 'c', step: { ...STEP, previousActions: [1] } }],
    ['elements not an array', { type: 'decider.step', conversationId: 'c', step: { ...STEP, elements: {} } }],
    ['element without an index', { type: 'decider.step', conversationId: 'c', step: { ...STEP, elements: [{ tag: 'a', name: 'x', sensitive: false }] } }],
    ['element sensitive not boolean', { type: 'decider.step', conversationId: 'c', step: { ...STEP, elements: [{ index: 0, tag: 'a', name: 'x', sensitive: 'no' }] } }],
    ['element value not a string', { type: 'decider.step', conversationId: 'c', step: { ...STEP, elements: [{ index: 0, tag: 'a', name: 'x', sensitive: false, value: 5 }] } }],
    ['too many elements', { type: 'decider.step', conversationId: 'c', step: { ...STEP, elements: Array.from({ length: 1001 }, (_, i) => ({ index: i, tag: 'a', name: 'x', sensitive: false })) } }],
    ['unknown action', { type: 'decider.step', conversationId: 'c', step: { ...STEP, spec: { action: 'submit' } } }],
    ['negative index', { type: 'decider.step', conversationId: 'c', step: { ...STEP, spec: { action: 'click', index: -1 } } }],
    ['unknown direction', { type: 'decider.step', conversationId: 'c', step: { ...STEP, spec: { action: 'scroll', direction: 'left' } } }],
  ])('rejects %s', (_label, raw) => {
    expect(parseDeciderRelay(raw)).toBeNull()
  })
})

describe('forwardDeciderHooks (the service-worker side)', () => {
  const input = () => ({
    tabId: 7,
    snap: snap([el({ index: 0, tag: 'input', type: 'password', name: 'Password', value: 'hunter2', sensitive: true })]),
    spec: { action: 'type', index: 0, text: 'hunter2' } as ControlSpec,
    session: session({ journal: journal(['before']) }),
  })

  it('posts each step for its conversation, captured at call time, when the decider is on', () => {
    const send = vi.fn()
    const hooks = forwardDeciderHooks({ conversationId: 'conv-1', settings: () => ({ mode: 'shadow' }), send })
    const i = input()
    expect(hooks.observeStep(i)).toBeUndefined()
    i.session.journal!.push(...journal(['the step itself'])) // lands after the send
    expect(send).toHaveBeenCalledTimes(1)
    const msg = send.mock.calls[0][0] as DeciderRelayMsg
    expect(msg).toMatchObject({ type: 'decider.step', conversationId: 'conv-1', step: { tabId: 7, previousActions: ['before'], spec: { action: 'type', index: 0 } } })
    expect(JSON.stringify(msg)).not.toContain('hunter2')
    expect(parseDeciderRelay(JSON.parse(JSON.stringify(msg)))).toEqual(msg)

    hooks.sessionGranted()
    expect(send).toHaveBeenLastCalledWith({ type: 'decider.granted', conversationId: 'conv-1' })
  })

  it('sends nothing when the decider is off, so page structure never rides the channel for it', () => {
    const send = vi.fn()
    for (const settings of [undefined, { mode: 'off' }] as (DeciderSettings | undefined)[]) {
      const hooks = forwardDeciderHooks({ conversationId: 'c', settings: () => settings, send })
      hooks.observeStep(input())
      hooks.sessionGranted()
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('never throws and never surfaces a rejection — no panel open is the normal case', async () => {
    const rejects = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'shadow' }), send: () => Promise.reject(new Error('Receiving end does not exist.')) })
    const throws = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'shadow' }), send: () => { throw new Error('Extension context invalidated.') } })
    const badSettings = forwardDeciderHooks({ conversationId: 'c', settings: () => { throw new Error('boom') }, send: vi.fn() })
    for (const h of [rejects, throws, badSettings]) {
      expect(() => h.observeStep(input())).not.toThrow()
      expect(() => h.sessionGranted()).not.toThrow()
    }
    await new Promise((r) => setTimeout(r, 10)) // an unhandled rejection here fails the run
  })

  it("mode() is 'off' until the model is ready; mapForm is Task 11's stub", async () => {
    const hooks = forwardDeciderHooks({ conversationId: 'c', settings: () => ({ mode: 'assist', actThreshold: 0.7 }), send: vi.fn(), modelReady: async () => true })
    expect(hooks.mode()).toBe('off')
    await new Promise((r) => setTimeout(r, 10))
    expect(hooks.mode()).toBe('assist')
    expect(hooks.threshold()).toBe(0.7)
    const i = input()
    expect(await hooks.mapForm({ tabId: 7, snap: i.snap, session: i.session, values: {} })).toEqual({ error: 'assist mode is not implemented yet' })
  })
})
