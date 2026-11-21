import type { Answer } from './readout'
import type { FillQuestion, FormField, Lookup } from './state'

export interface FillPlan {
  fills: { index: number; kind: FormField['kind']; key: string; value: string; p: number }[]
  /**
   * `failed` is never planned: AutofillForm adds it when a planned fill's action did not succeed
   * on the page, so the model is told that field is still empty.
   */
  left: { index: number; reason: 'low-confidence' | 'leave-empty' | 'already-set' | 'failed' }[]
}

export function planFill(
  questions: FillQuestion[],
  answers: Record<string, Answer>,
  lookup: Lookup,
  threshold: number,
): FillPlan {
  const plan: FillPlan = { fills: [], left: [] }
  for (const q of questions) {
    const a = answers[q.name]
    const index = q.field.index
    if (q.field.kind === 'checkbox' && q.field.checked) {
      plan.left.push({ index, reason: 'already-set' })
      continue
    }
    if (!a) {
      plan.left.push({ index, reason: 'low-confidence' })
      continue
    }
    if (q.field.kind === 'checkbox') {
      const yes = a.yes ?? 0
      if (yes >= threshold) plan.fills.push({ index, kind: 'checkbox', key: 'tick', value: 'tick', p: yes })
      else plan.left.push({ index, reason: 'low-confidence' })
      continue
    }
    if (a.p < threshold) {
      plan.left.push({ index, reason: 'low-confidence' })
      continue
    }
    if (q.field.kind === 'select') {
      plan.fills.push({ index, kind: 'select', key: a.top, value: a.top, p: a.p })
      continue
    }
    if (a.top === 'leave_empty') {
      plan.left.push({ index, reason: 'leave-empty' })
      continue
    }
    const [group, ...rest] = a.top.split('.')
    const k = rest.join('.')
    const table = group === 'profile' ? lookup.profile : group === 'request' ? lookup.request : undefined
    const value = table && Object.hasOwn(table, k) ? table[k] : undefined
    if (value === undefined) plan.left.push({ index, reason: 'low-confidence' })
    else plan.fills.push({ index, kind: 'text', key: a.top, value, p: a.p })
  }
  return plan
}
