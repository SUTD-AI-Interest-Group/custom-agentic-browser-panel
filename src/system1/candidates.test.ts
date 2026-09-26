import { describe, it, expect } from 'vitest'
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import { buildObservation } from './observation'
import { buildCandidateSpace, goalWords, rankControls, SHOWN_CONTROLS } from './candidates'

const el = (index: number, over: Partial<IndexedElement> = {}): IndexedElement =>
  ({ index, tag: 'button', name: `Button ${index}`, rect: { x: 0, y: 0, width: 10, height: 10 }, sensitive: false, ...over }) as IndexedElement
const obs = (elements: IndexedElement[], over: Partial<PageSnapshot> = {}) =>
  buildObservation({ url: 'https://shop.example/', title: 'Shop', origin: 'https://shop.example', dpr: 1, elements, text: '', truncated: false, ...over })
const space = (elements: IndexedElement[], values: Record<string, string> = {}, goal = 'do the thing', over: Partial<PageSnapshot> = {}) =>
  buildCandidateSpace({ goal, observation: obs(elements, over), values, history: [] })

describe('buildCandidateSpace', () => {
  it('offers CLICK for clickables and the field operations only when values exist', () => {
    const els = [el(0), el(1, { tag: 'input', type: 'email', name: 'Email' }), el(2, { tag: 'select', name: 'Size' })]
    const none = space(els)
    expect(none.targets).toEqual({ CLICK: [0, 1, 2], TYPE_TEXT: [], SELECT_OPTION: [] })
    expect(none.operations).not.toContain('TYPE_TEXT')
    expect(none.operations).not.toContain('SELECT_OPTION')
    const some = space(els, { email: 'a@b.co' })
    expect(some.targets.TYPE_TEXT).toEqual([1])
    expect(some.targets.SELECT_OPTION).toEqual([2])
    expect(some.operations).toEqual(expect.arrayContaining(['CLICK', 'TYPE_TEXT', 'SELECT_OPTION']))
    expect(some.valueKeys).toEqual(['email'])
  })

  it('never lists a sensitive control as a target, even if its actions were non-empty', () => {
    const o = obs([el(0), el(1, { tag: 'input', type: 'password', name: 'Password', sensitive: true })])
    // Simulate the first guard failing: give the sensitive control actions anyway.
    o.controls[1].actions = ['click', 'type_text']
    const s = buildCandidateSpace({ goal: 'log in', observation: o, values: { pw: 'x' }, history: [] })
    expect(s.targets.CLICK).toEqual([0])
    expect(s.targets.TYPE_TEXT).toEqual([])
    expect(s.shown).toContain(1) // still visible in the state block, so BLOCKED can be recognised
  })

  it('withholds CLICK from a disabled control and TYPE_TEXT from a read-only field', () => {
    const s = space([el(0, { disabled: true }), el(1, { tag: 'input', type: 'text', readonly: true, name: 'Ref' }), el(2)], { v: 'x' })
    expect(s.targets.CLICK).toEqual([1, 2])
    expect(s.targets.TYPE_TEXT).toEqual([])
  })

  it('omits CLICK entirely when nothing is clickable, keeping WAIT/DONE/BLOCKED', () => {
    const s = space([el(0, { disabled: true })])
    expect(s.operations).toEqual(['SCROLL_DOWN', 'SCROLL_UP', 'WAIT', 'DONE', 'BLOCKED'])
    const empty = space([])
    expect(empty.operations).toContain('DONE')
    expect(empty.operations).not.toContain('CLICK')
  })

  it('offers scroll operations only when the page can scroll that way', () => {
    expect(space([el(0)], {}, 'g', { scroll: { y: 0, max: 0 } }).operations).toEqual(['CLICK', 'WAIT', 'DONE', 'BLOCKED'])
    expect(space([el(0)], {}, 'g', { scroll: { y: 0, max: 900 } }).operations).toEqual(['CLICK', 'SCROLL_DOWN', 'WAIT', 'DONE', 'BLOCKED'])
    expect(space([el(0)], {}, 'g', { scroll: { y: 900, max: 900 } }).operations).toEqual(['CLICK', 'SCROLL_UP', 'WAIT', 'DONE', 'BLOCKED'])
  })

  it('caps shown at SHOWN_CONTROLS with honest stats while every eligible control stays a target', () => {
    const els = Array.from({ length: SHOWN_CONTROLS + 15 }, (_, i) => el(i))
    const s = space(els)
    expect(s.shown).toHaveLength(SHOWN_CONTROLS)
    expect(s.targets.CLICK).toHaveLength(SHOWN_CONTROLS + 15)
    expect(s.stats).toEqual({ controls: SHOWN_CONTROLS + 15, eligible: SHOWN_CONTROLS + 15, shown: SHOWN_CONTROLS, hidden: 15 })
  })
})

describe('rankControls', () => {
  it('splits goal words and ignores short ones and punctuation', () => {
    expect(goalWords('Add the blue Aurora mug, to the cart!')).toEqual(['add', 'the', 'blue', 'aurora', 'mug', 'cart'])
  })

  it('puts controls whose name or group overlaps the goal first, ties in document order', () => {
    const els = [el(0, { name: 'Cart' }), el(1, { name: 'Add Nimbus tote (red) to cart' }), el(2, { name: 'Add Aurora mug (blue) to cart' }), el(3, { name: 'Help' })]
    const ranked = rankControls('add the blue Aurora mug to the cart', obs(els).controls, [], [])
    expect(ranked.map((c) => c.id)).toEqual([2, 1, 0, 3])
    // The candidate space's target lists follow that order.
    expect(space(els, {}, 'add the blue Aurora mug to the cart').targets.CLICK).toEqual([2, 1, 0, 3])
  })

  it('matches on the group name too, prefers fields when values exist, and demotes a control already acted on', () => {
    const els = [el(0, { tag: 'input', type: 'text', name: 'First name', ancestorName: 'Passenger details' }), el(1, { name: 'Continue' }), el(2, { tag: 'input', type: 'text', name: 'Last name' })]
    const grouped = rankControls('passenger details', obs(els).controls, [], [])
    expect(grouped[0].id).toBe(0)
    const withValues = rankControls('fill the form', obs(els).controls, ['first'], [])
    expect(withValues.map((c) => c.id)).toEqual([0, 2, 1])
    const afterFirst = rankControls('fill the form', obs(els).controls, ['first'], [{ targetId: 0, result: 'success' }])
    expect(afterFirst.map((c) => c.id)).toEqual([2, 0, 1])
  })

  it('is deterministic', () => {
    const els = [el(0), el(1), el(2)]
    const a = rankControls('x', obs(els).controls, [], []).map((c) => c.id)
    const b = rankControls('x', obs(els).controls, [], []).map((c) => c.id)
    expect(a).toEqual(b)
    expect(a).toEqual([0, 1, 2])
  })
})
