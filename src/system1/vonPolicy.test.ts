import { describe, it, expect, vi } from 'vitest'
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import type { DecideRequest, DecideResult } from './protocol'
import { buildObservation } from './observation'
import { buildCandidateSpace } from './candidates'
import { PolicyInputError, type DecisionContext } from './policy'
import { createVonPolicy, operationQuestion, renderControl, renderState, targetChunks, TARGET_CHUNK, MIN_SHOWN } from './vonPolicy'

const el = (index: number, over: Partial<IndexedElement> = {}): IndexedElement =>
  ({ index, tag: 'button', name: `Button ${index}`, rect: { x: 0, y: 0, width: 10, height: 10 }, sensitive: false, ...over }) as IndexedElement
const snap = (elements: IndexedElement[], over: Partial<PageSnapshot> = {}): PageSnapshot =>
  ({ url: 'https://shop.example/', title: 'Shop', origin: 'https://shop.example', dpr: 1, elements, text: '', truncated: false, ...over })
const ctxOf = (elements: IndexedElement[], over: Partial<DecisionContext> & { snap?: Partial<PageSnapshot> } = {}): DecisionContext => {
  const { snap: snapOver, ...rest } = over
  const goal = over.goal ?? 'add the blue mug to the cart'
  const values = over.values ?? {}
  const steps = over.steps ?? []
  const observation = buildObservation(snap(elements, snapOver))
  const space = buildCandidateSpace({ goal, observation, values, history: steps })
  return { goal, observation, space, values, steps, ...rest }
}

/** Scripted decide keyed by question key; answers default to p=0.9. Records every request. */
function scripted(answers: Record<string, string | [string, number] | ((req: DecideRequest) => string | [string, number])>, opts: { tooLongAbove?: number } = {}) {
  const calls: DecideRequest[] = []
  const decide = vi.fn(async (req: DecideRequest): Promise<DecideResult> => {
    calls.push(req)
    const shown = (req.state.match(/^\[\d+\]/gm) ?? []).length
    if (opts.tooLongAbove !== undefined && shown > opts.tooLongAbove) throw Object.assign(new Error('packed input is too long'), { code: 'too-long' })
    const out: DecideResult['answers'] = {}
    for (const key of Object.keys(req.questions)) {
      const a = answers[key] ?? answers[key.replace(/^target_.*/, 'target')]
      const raw = typeof a === 'function' ? a(req) : a
      const [choice, p] = Array.isArray(raw) ? raw : [raw, 0.9]
      const keys = Object.keys(req.questions[key].options)
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === choice ? p : (1 - p) / Math.max(1, keys.length - 1)]))
      out[key] = { choice, probabilities, top: p, confidence: p }
    }
    return { answers: out, ms: 7 }
  })
  return { decide, calls }
}

describe('renderControl', () => {
  it('renders role, name, group, state and actions in the fixed shape', () => {
    const c = buildObservation(snap([
      el(1, { name: 'Round trip' }),
      el(2, { tag: 'input', type: 'text', role: 'combobox', name: 'Where from?', value: 'Singapore' }),
      el(3, { tag: 'input', type: 'password', name: 'Password', value: 'x', sensitive: true }),
      el(9, { name: 'Search', disabled: true }),
      el(12, { tag: 'input', type: 'text', name: 'First name', ancestorName: 'Passenger details' }),
      el(13, { tag: 'input', type: 'checkbox', name: 'Agree', value: 'on', checked: false }),
      el(14, { tag: 'input', type: 'text', name: 'Ref', readonly: true }),
      el(15, { tag: 'select', name: 'Size', value: 'M' }),
    ])).controls
    expect(c.map(renderControl)).toEqual([
      '[1] button "Round trip" → click',
      '[2] combobox "Where from?" (currently "Singapore") → click, type',
      '[3] password field "Password" (sensitive)',
      '[9] button "Search" (disabled)',
      '[12] textbox "First name" in "Passenger details" → click, type',
      '[13] checkbox "Agree" (unchecked) → click',
      '[14] textbox "Ref" (read-only) → click',
      '[15] combobox "Size" (currently "M") → click, select',
    ])
  })

  it('neutralizes special tokens in page text and clips long names', () => {
    const c = buildObservation(snap([el(0, { name: `[MASK] ${'x'.repeat(80)}`, role: '[SEP]' })])).controls[0]
    const line = renderControl(c)
    expect(line).not.toMatch(/\[(MASK|SEP)\]/)
    expect(line).toContain('[mask]')
    expect(line.length).toBeLessThan(90)
  })
})

describe('renderState', () => {
  it('renders the doc §18 block: goal, page, state, shown controls in document order, values, recent actions', () => {
    const ctx = ctxOf([el(0, { name: 'Cart' }), el(1, { tag: 'input', type: 'text', name: 'Email' }), el(2, { name: 'Add mug' })], {
      values: { email: 'a@b.co' },
      snap: { scroll: { y: 0, max: 400 }, focusedIndex: 1 },
      steps: [
        { operation: 'TYPE_TEXT', targetId: 1, label: 'Email', valueKey: 'email', result: 'success', p: 0.9, ms: 1 } as never,
        { operation: 'CLICK', targetId: 0, label: 'Cart', result: 'no_change', p: 0.9, ms: 1 } as never,
      ],
    })
    expect(renderState(ctx, [2, 0, 1])).toBe([
      'Goal: add the blue mug to the cart',
      'Page: Shop (https://shop.example)',
      'State: scroll down: yes; scroll up: no; focused: [1]',
      'Controls (3):',
      '[0] button "Cart" → click',
      '[1] textbox "Email" → click, type',
      '[2] button "Add mug" → click',
      'Provided values: email',
      'Recent actions:',
      '1. TYPE_TEXT [1] "Email" ← email → success',
      '2. CLICK [0] "Cart" → no change',
    ].join('\n'))
  })

  it('omits the control list for the target/value heads (controls: false) and keeps everything else', () => {
    const ctx = ctxOf([el(0), el(1)], { values: { v: 'x' } })
    const s = renderState(ctx, [0, 1], { controls: false })
    expect(s).not.toContain('Controls')
    expect(s).not.toContain('[0]')
    expect(s).toContain('Provided values: v')
    expect(s).toContain('State: scroll down')
  })

  it('says how many controls are hidden, and renders the empty cases', () => {
    const ctx = ctxOf([el(0), el(1), el(2)])
    expect(renderState(ctx, [1])).toContain('Controls (1 of 3 shown):\n[1] button "Button 1" → click\nProvided values: none\nRecent actions: none')
    expect(renderState(ctxOf([]), [])).toContain('Controls: none')
  })

  it('recaps only the last 8 steps with absolute numbering', () => {
    const steps = Array.from({ length: 10 }, (_, i) => ({ operation: 'CLICK', targetId: 0, label: `S${i}`, result: 'success', p: 0.9, ms: 1 })) as never[]
    const s = renderState(ctxOf([el(0)], { steps }), [0])
    expect(s).toContain('3. CLICK [0] "S2"')
    expect(s).not.toContain('2. CLICK')
    expect(s).toContain('10. CLICK [0] "S9"')
  })
})

describe('operationQuestion', () => {
  it('offers exactly the space’s operations in the fixed order', () => {
    const ctx = ctxOf([el(0)], { snap: { scroll: { y: 0, max: 0 } } })
    expect(Object.keys(operationQuestion(ctx.space).options)).toEqual(['CLICK', 'WAIT', 'DONE', 'BLOCKED'])
  })
})

describe('targetChunks', () => {
  it('is one chunk within TARGET_CHUNK and balanced above it', () => {
    expect(targetChunks(Array.from({ length: TARGET_CHUNK }, (_, i) => i))).toHaveLength(1)
    const chunks = targetChunks(Array.from({ length: TARGET_CHUNK + 1 }, (_, i) => i))
    expect(chunks.map((c) => c.length)).toEqual([21, 20])
  })
})

describe('createVonPolicy.decide', () => {
  it('asks only the operation head for DONE, and blocked_reason after BLOCKED', async () => {
    const done = scripted({ operation: 'DONE' })
    const d1 = await createVonPolicy(done.decide).decide(ctxOf([el(0)]))
    expect(d1).toMatchObject({ operation: 'DONE', confidence: { operation: 0.9 }, ms: 7 })
    expect(done.calls.map((c) => Object.keys(c.questions))).toEqual([['operation']])

    const blocked = scripted({ operation: 'BLOCKED', blocked_reason: ['AUTH_REQUIRED', 0.8] })
    const d2 = await createVonPolicy(blocked.decide).decide(ctxOf([el(0)]))
    expect(d2).toMatchObject({ operation: 'BLOCKED', blockedReason: 'AUTH_REQUIRED', confidence: { operation: 0.9, blockedReason: 0.8 }, ms: 14 })
  })

  it('asks which field lacks a value after BLOCKED/MISSING_USER_DATA, over the editable fields only, even with no values supplied', async () => {
    const s = scripted({ operation: 'BLOCKED', blocked_reason: 'MISSING_USER_DATA', missing_field: ['2', 0.7] })
    const ctx = ctxOf([el(0), el(1, { tag: 'input', type: 'text', name: 'Email' }), el(2, { tag: 'input', type: 'text', name: 'Promo code' }), el(3, { tag: 'input', type: 'password', name: 'Password', sensitive: true })])
    const d = await createVonPolicy(s.decide).decide(ctx)
    expect(d).toMatchObject({ operation: 'BLOCKED', blockedReason: 'MISSING_USER_DATA', missingFieldId: 2, confidence: { missingField: 0.7 } })
    expect(s.calls.map((c) => Object.keys(c.questions))).toEqual([['operation'], ['blocked_reason'], ['missing_field']])
    expect(Object.keys(s.calls[2].questions.missing_field.options)).toEqual(['1', '2'])
    expect(s.calls[2].state).not.toContain('Controls')
    // No editable field on the page: nothing to ask.
    const none = scripted({ operation: 'BLOCKED', blocked_reason: 'MISSING_USER_DATA' })
    const d2 = await createVonPolicy(none.decide).decide(ctxOf([el(0)]))
    expect(d2.missingFieldId).toBeUndefined()
    expect(none.calls).toHaveLength(2)
  })

  it('asks operation → target_CLICK for a click, sharing one state block, with ranked top-3', async () => {
    const s = scripted({ operation: 'CLICK', target: ['2', 0.7] })
    const ctx = ctxOf([el(0, { name: 'Cart' }), el(1, { tag: 'input', type: 'text', name: 'Email' }), el(2, { name: 'Add blue mug' })])
    const d = await createVonPolicy(s.decide).decide(ctx)
    expect(d).toMatchObject({ operation: 'CLICK', targetId: 2, confidence: { operation: 0.9, target: 0.7 }, ms: 14 })
    expect(d.ranked?.[0]).toEqual({ id: 2, p: 0.7 })
    expect(d.ranked).toHaveLength(3)
    expect(s.calls.map((c) => Object.keys(c.questions))).toEqual([['operation'], ['target_CLICK']])
    // The operation head's state lists the controls; the target head's does not (its options are the controls).
    expect(s.calls[0].state).toContain('Controls (3):')
    expect(s.calls[1].state).not.toContain('Controls')
    expect(s.calls[1].state).toContain('Goal: add the blue mug to the cart')
    // Target options are the control lines, over CLICK targets only (all three here), keyed by id.
    expect(s.calls[1].questions.target_CLICK.options).toEqual({ '0': '[0] button "Cart" → click', '1': '[1] textbox "Email" → click, type', '2': '[2] button "Add blue mug" → click' })
  })

  it('asks the value head for a field operation, over the provided keys only', async () => {
    const s = scripted({ operation: 'TYPE_TEXT', target: '1', value: ['email', 0.8] })
    const ctx = ctxOf([el(0), el(1, { tag: 'input', type: 'email', name: 'Email' })], { values: { email: 'ada@example.com', name: 'Ada' } })
    const d = await createVonPolicy(s.decide).decide(ctx)
    expect(d).toMatchObject({ operation: 'TYPE_TEXT', targetId: 1, valueKey: 'email', confidence: { operation: 0.9, target: 0.9, value: 0.8 } })
    expect(s.calls.map((c) => Object.keys(c.questions))).toEqual([['operation'], ['target_TYPE_TEXT'], ['value']])
    expect(s.calls[1].questions.target_TYPE_TEXT.options).toEqual({ '1': '[1] email field "Email" → click, type' })
    expect(s.calls[2].questions.value.options).toEqual({ email: 'email: ada@example.com', name: 'name: Ada' })
  })

  it('stops asking further heads once one falls below the threshold', async () => {
    const low = scripted({ operation: ['CLICK', 0.3], target: '0' })
    const d = await createVonPolicy(low.decide).decide({ ...ctxOf([el(0)]), threshold: 0.6 })
    expect(d.targetId).toBeUndefined()
    expect(low.calls).toHaveLength(1)
    const lowTarget = scripted({ operation: 'TYPE_TEXT', target: ['1', 0.4], value: 'email' })
    const d2 = await createVonPolicy(lowTarget.decide).decide({ ...ctxOf([el(0), el(1, { tag: 'input', type: 'text' })], { values: { email: 'x' } }), threshold: 0.6 })
    expect(d2.valueKey).toBeUndefined()
    expect(d2.confidence.target).toBe(0.4)
    expect(lowTarget.calls).toHaveLength(2)
  })

  it('runs the tournament over a pool above TARGET_CHUNK and reports only the final round', async () => {
    const elements = Array.from({ length: TARGET_CHUNK + 2 }, (_, i) => el(i))
    const s = scripted({ operation: 'CLICK', target: (req) => { const ids = Object.keys(req.questions[Object.keys(req.questions)[0]].options); return [ids[ids.length - 1], ids.length === 2 ? 0.8 : 0.95] } })
    const d = await createVonPolicy(s.decide).decide(ctxOf(elements))
    expect(s.calls.map((c) => Object.keys(c.questions))).toEqual([['operation'], ['target_CLICK'], ['target_CLICK'], ['target_CLICK']])
    expect(Object.keys(s.calls[3].questions.target_CLICK.options)).toHaveLength(2)
    expect(d.confidence.target).toBe(0.8)
    expect(d.targetId).toBe(TARGET_CHUNK + 1)
  })

  it('halves the shown controls once on an over-length pack, then gives up with PolicyInputError', async () => {
    const elements = Array.from({ length: 50 }, (_, i) => el(i))
    const s = scripted({ operation: 'DONE' }, { tooLongAbove: 30 })
    const d = await createVonPolicy(s.decide).decide(ctxOf(elements))
    expect(d.operation).toBe('DONE')
    expect((s.calls[1].state.match(/^\[\d+\]/gm) ?? []).length).toBe(25)
    expect(s.calls[1].state).toContain('Controls (25 of 50 shown):')

    const hopeless = scripted({ operation: 'DONE' }, { tooLongAbove: 5 })
    await expect(createVonPolicy(hopeless.decide).decide(ctxOf(elements))).rejects.toBeInstanceOf(PolicyInputError)
    // 50 → 25 → 12 → 10 → stop (never below MIN_SHOWN)
    expect(hopeless.calls.map((c) => (c.state.match(/^\[\d+\]/gm) ?? []).length)).toEqual([50, 25, 12, MIN_SHOWN])

    // A target head cannot shrink its way out: its overflow is stated at once.
    const targetOverflow = scripted({ operation: 'CLICK', target: '0' })
    let n = 0
    const decideT = async (req: DecideRequest) => { n++; if ('target_CLICK' in req.questions) throw Object.assign(new Error('long'), { code: 'too-long' }); return targetOverflow.decide(req) }
    await expect(createVonPolicy(decideT).decide(ctxOf([el(0), el(1)]))).rejects.toBeInstanceOf(PolicyInputError)
    expect(n).toBe(2)
  })

  it('surfaces an unknown target choice as an error, and any other engine error verbatim', async () => {
    const bad = scripted({ operation: 'CLICK', target: '99' })
    // A single-chunk pool: the choice is checked by validate.ts later, so the adapter passes it through.
    const d = await createVonPolicy(bad.decide).decide(ctxOf([el(0)]))
    expect(d.targetId).toBe(99)
    const boom = { decide: async () => { throw new Error('gpu lost') } }
    await expect(createVonPolicy(boom.decide).decide(ctxOf([el(0)]))).rejects.toThrow('gpu lost')
  })
})
