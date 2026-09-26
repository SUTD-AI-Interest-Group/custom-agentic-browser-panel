import { describe, it, expect } from 'vitest'
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import { buildObservation } from './observation'
import { buildCandidateSpace } from './candidates'
import type { BrowserDecision } from './policy'
import { validateDecision, WAIT_TIMEOUT_MS } from './validate'

const el = (index: number, over: Partial<IndexedElement> = {}): IndexedElement =>
  ({ index, tag: 'button', name: `Button ${index}`, rect: { x: 0, y: 0, width: 10, height: 10 }, sensitive: false, ...over }) as IndexedElement
const obsOf = (elements: IndexedElement[], over: Partial<PageSnapshot> = {}) =>
  buildObservation({ url: 'https://shop.example/', title: 'Shop', origin: 'https://shop.example', dpr: 1, elements, text: '', truncated: false, ...over })
const d = (over: Partial<BrowserDecision>): BrowserDecision => ({ operation: 'CLICK', confidence: { operation: 0.9 }, ms: 1, ...over })

const elements = [el(0), el(1, { tag: 'input', type: 'email', name: 'Email' }), el(2, { tag: 'select', name: 'Size' }), el(3, { tag: 'input', type: 'password', name: 'Password', sensitive: true }), el(4, { disabled: true })]
const values = { email: 'a@b.co', size: 'M' }
const obs = obsOf(elements, { scroll: { y: 0, max: 100 } })
const space = buildCandidateSpace({ goal: 'g', observation: obs, values, history: [] })

describe('validateDecision', () => {
  it('maps CLICK to a click spec carrying the target fingerprint', () => {
    const v = validateDecision(d({ targetId: 0 }), space, obs, values)
    expect(v).toEqual({ ok: true, action: { operation: 'CLICK', spec: { action: 'click', index: 0 }, targetId: 0, expect: { id: 0, fingerprint: { tag: 'button', type: undefined, name: 'Button 0', href: undefined, sensitive: false } } } })
  })

  it('maps TYPE_TEXT to a clearing type with the value verbatim, and SELECT_OPTION to a select', () => {
    const t = validateDecision(d({ operation: 'TYPE_TEXT', targetId: 1, valueKey: 'email' }), space, obs, values)
    expect(t.ok && t.action.spec).toEqual({ action: 'type', index: 1, text: 'a@b.co', clear: true })
    const s = validateDecision(d({ operation: 'SELECT_OPTION', targetId: 2, valueKey: 'size' }), space, obs, values)
    expect(s.ok && s.action.spec).toEqual({ action: 'select', index: 2, value: 'M' })
    expect(s.ok && s.action.valueKey).toBe('size')
  })

  it('maps the global operations with no target', () => {
    expect(validateDecision(d({ operation: 'SCROLL_DOWN' }), space, obs, values)).toEqual({ ok: true, action: { operation: 'SCROLL_DOWN', spec: { action: 'scroll', direction: 'down' } } })
    expect(validateDecision(d({ operation: 'WAIT' }), space, obs, values)).toEqual({ ok: true, action: { operation: 'WAIT', spec: { action: 'wait', timeoutMs: WAIT_TIMEOUT_MS } } })
  })

  it('rejects an operation the space does not offer (SCROLL_UP at the top; TYPE_TEXT without values)', () => {
    expect(validateDecision(d({ operation: 'SCROLL_UP' }), space, obs, values).ok).toBe(false)
    const noValues = buildCandidateSpace({ goal: 'g', observation: obs, values: {}, history: [] })
    expect(validateDecision(d({ operation: 'TYPE_TEXT', targetId: 1, valueKey: 'email' }), noValues, obs, {}).ok).toBe(false)
  })

  it('rejects a target outside that operation’s list: a sensitive field, a disabled button, a button for TYPE_TEXT, a missing id', () => {
    expect(validateDecision(d({ targetId: 3 }), space, obs, values).ok).toBe(false)
    expect(validateDecision(d({ targetId: 4 }), space, obs, values).ok).toBe(false)
    expect(validateDecision(d({ operation: 'TYPE_TEXT', targetId: 0, valueKey: 'email' }), space, obs, values).ok).toBe(false)
    expect(validateDecision(d({ targetId: 99 }), space, obs, values).ok).toBe(false)
    expect(validateDecision(d({}), space, obs, values).ok).toBe(false)
  })

  it('rejects an unknown value key and a terminal answer', () => {
    expect(validateDecision(d({ operation: 'TYPE_TEXT', targetId: 1, valueKey: 'nope' }), space, obs, values).ok).toBe(false)
    expect(validateDecision(d({ operation: 'TYPE_TEXT', targetId: 1 }), space, obs, values).ok).toBe(false)
    expect(validateDecision(d({ operation: 'DONE' }), space, obs, values).ok).toBe(false)
  })
})
