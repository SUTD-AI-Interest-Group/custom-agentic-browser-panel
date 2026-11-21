import { describe, expect, it } from 'vitest'
import { CONTACT_FORM } from './__fixtures__/contactForm'
import { nextActionRequest, formFields, fillRequest, type Lookup } from './state'
import { planFill } from './fillPlan'
import type { Answer } from './readout'

const facts = (over = {}) => ({
  goal: 'g', plan: 'p', url: 'https://x.test/', title: 'T', previousActions: [], elements: CONTACT_FORM, ...over,
})
const opts = (r: ReturnType<typeof nextActionRequest>) => {
  const q = r.request.questions.next
  return Object.keys((q as { criteria: Record<string, unknown> }).criteria)
}

describe('nextActionRequest', () => {
  it('lists options in registry order then scroll/done', () => {
    const r = nextActionRequest(facts())
    expect(opts(r).slice(3)).toEqual([
      'type into [3]', 'type into [4]', 'type into [5]', 'select in [6]', 'type into [7]',
      'click [8]', 'click [9]', 'click [10]', 'click [11]', 'scroll down', 'done',
    ])
    expect(opts(r).slice(0, 3)).toEqual(['click [0]', 'click [1]', 'click [2]'])
    expect(r.actions.slice(-2)).toEqual([{ op: 'scroll' }, { op: 'done' }])
    const q = r.request.questions.next as { criteria: Record<string, string> }
    expect(q.criteria['type into [4]']).toBe('<input> email "Email address"')
    expect(r.request.questions.next.instructions).toBe(
      'What is the single next browser action that makes progress toward the goal?',
    )
    expect(q.criteria['scroll down']).toBe('reveal more of the page')
    expect(q.criteria.done).toBe('the goal is complete, or the answer is now visible on the page')
  })
  it('slices previous_actions and adds page_text only when given', () => {
    const prev = Array.from({ length: 9 }, (_, i) => `a${i}`)
    const s = nextActionRequest(facts({ previousActions: prev })).request.state as Record<string, unknown>
    expect(s.previous_actions).toEqual(prev.slice(-6))
    expect(Object.keys(s)).toEqual(['goal', 'plan', 'url', 'title', 'previous_actions'])
    const s2 = nextActionRequest(facts({ pageText: 'hi' })).request.state as Record<string, unknown>
    expect(s2.page_text).toBe('hi')
  })
  it('truncates long descriptions to 120', () => {
    const long = { ...CONTACT_FORM[0], name: 'x'.repeat(300) }
    const r = nextActionRequest(facts({ elements: [long] }))
    const d = (r.request.questions.next as { criteria: Record<string, string> }).criteria['click [0]']
    expect(d.length).toBeLessThanOrEqual(120)
    expect(d.endsWith('…')).toBe(true)
  })
})

const lookup: Lookup = { profile: { full_name: 'Ada', email: 'ada@example.com' }, request: { message: 'hi' } }
describe('form fill', () => {
  const fields = formFields(CONTACT_FORM, { 6: ['Billing', 'Sales'] })
  it('formFields skips buttons, links and sensitive', () => {
    expect(fields.map((f) => f.index)).toEqual([3, 4, 5, 6, 7, 8, 9])
    const pw = { ...CONTACT_FORM[3], index: 20, type: 'password', sensitive: true }
    expect(formFields([pw], {})).toEqual([])
  })
  it('fillRequest builds typed questions', () => {
    const { request, questions } = fillRequest({ goal: 'g', url: 'u', title: 't', lookup, fields })
    const q3 = request.questions.f3 as { type: string; criteria: Record<string, unknown>; instructions: string }
    expect(q3.type).toBe('choice')
    expect(Object.keys(q3.criteria)).toEqual(['profile.full_name', 'profile.email', 'request.message', 'leave_empty'])
    expect(Object.values(q3.criteria).every((v) => v === null)).toBe(true)
    expect(q3.instructions).toBe('Which value from info should fill the form field [3]<input> "Full name"?')
    expect(Object.keys((request.questions.f6 as { criteria: object }).criteria)).toEqual(['Billing', 'Sales'])
    expect(request.questions.f8.type).toBe('noul')
    expect(questions).toHaveLength(7)
    expect(Object.keys(request.state as object)).toEqual(['goal', 'page', 'info'])
  })
  it('skips selects with fewer than 2 options', () => {
    expect(formFields(CONTACT_FORM, { 6: ['Only'] }).some((f) => f.index === 6)).toBe(false)
    expect(formFields(CONTACT_FORM, {}).some((f) => f.index === 6)).toBe(false)
  })
  it('planFill edge cases', () => {
    const { questions } = fillRequest({ goal: 'g', url: 'u', title: 't', lookup, fields })
    const a: Answer = { kind: 'choice', options: [], probs: [], top: 'profile.nope', p: 0.9, confidence: 0.9 }
    const p1 = planFill(questions.filter((q) => q.name === 'f3'), { f3: a }, lookup, 0.6)
    expect(p1.left).toEqual([{ index: 3, reason: 'low-confidence' }])
    const p2 = planFill(questions.filter((q) => q.name === 'f3'), { f3: { ...a, top: 'profile.constructor' } }, lookup, 0.6)
    expect(p2.fills).toEqual([])
    const chk = fillRequest({ goal: 'g', url: 'u', title: 't', lookup, fields: [{ ...fields[5], checked: true }] })
    expect(planFill(chk.questions, {}, lookup, 0.6).left).toEqual([{ index: 8, reason: 'already-set' }])
  })
  it('planFill', () => {
    const { questions } = fillRequest({ goal: 'g', url: 'u', title: 't', lookup, fields })
    const ans = (top: string, p: number, yes?: number): Answer => ({ kind: 'choice', options: [], probs: [], top, p, confidence: p, yes })
    const plan = planFill(
      questions,
      {
        f3: ans('profile.full_name', 0.9),
        f4: ans('profile.email', 0.5),
        f5: ans('leave_empty', 0.9),
        f6: ans('Billing', 0.9),
        f7: ans('request.message', 0.9),
        f8: ans('true', 0.9, 0.9),
        f9: ans('false', 0.9, 0.1),
      },
      lookup,
      0.6,
    )
    expect(plan.fills.map((f) => [f.index, f.value])).toEqual([[3, 'Ada'], [6, 'Billing'], [7, 'hi'], [8, 'tick']])
    expect(plan.left).toEqual([
      { index: 4, reason: 'low-confidence' },
      { index: 5, reason: 'leave-empty' },
      { index: 9, reason: 'low-confidence' },
    ])
    const checked = fillRequest({ goal: 'g', url: 'u', title: 't', lookup, fields: [{ ...fields[5], checked: true }] })
    expect(planFill(checked.questions, { f8: ans('true', 1, 1) }, lookup, 0.6).left).toEqual([{ index: 8, reason: 'already-set' }])
  })
})
