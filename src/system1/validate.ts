// The last check before anything touches the page: a decision is executed
// only if every part of it names a member of the candidate space the policy
// was given — the operation, the target for that operation, the value key —
// and it maps to a ControlSpec deterministically. The target's fingerprint
// rides along so the executor can refuse a stale index (doc §30–31).
import type { ControlSpec } from '../tools/pageControl'
import type { BrowserObservation, ControlFingerprint } from './observation'
import { isElementOperation, isFieldOperation, type BrowserOperation, type CandidateActionSpace } from './candidates'
import type { BrowserDecision } from './policy'

export const WAIT_TIMEOUT_MS = 3000

export interface ValidatedAction {
  operation: BrowserOperation
  spec: ControlSpec
  targetId?: number
  valueKey?: string
  /** For an element operation: what the policy saw at that index. The executor must refuse if the page no longer agrees. */
  expect?: { id: number; fingerprint: ControlFingerprint }
  /**
   * Set by the loop, never by validation: the decision fell between
   * ACT_TRY_CONFIDENCE and ACT_CONFIDENCE, so the executor may run it only if
   * it is not a point of no return.
   */
  tentative?: boolean
}

export type Validation = { ok: true; action: ValidatedAction } | { ok: false; reason: string }

export function validateDecision(
  d: BrowserDecision,
  space: CandidateActionSpace,
  obs: BrowserObservation,
  values: Record<string, string>,
): Validation {
  const op = d.operation
  if (!space.operations.includes(op)) return { ok: false, reason: `operation ${String(op)} is not available` }
  if (op === 'DONE' || op === 'BLOCKED') return { ok: false, reason: `${op} is a terminal answer, not an action` }
  if (op === 'SCROLL_DOWN' || op === 'SCROLL_UP')
    return { ok: true, action: { operation: op, spec: { action: 'scroll', direction: op === 'SCROLL_DOWN' ? 'down' : 'up' } } }
  if (op === 'WAIT') return { ok: true, action: { operation: op, spec: { action: 'wait', timeoutMs: WAIT_TIMEOUT_MS } } }
  if (!isElementOperation(op)) return { ok: false, reason: `unknown operation ${String(op)}` }

  if (d.targetId === undefined || !space.targets[op].includes(d.targetId))
    return { ok: false, reason: `[${d.targetId ?? '?'}] is not a ${op} target` }
  const control = obs.controls.find((c) => c.id === d.targetId)
  if (!control) return { ok: false, reason: `[${d.targetId}] is not on the page` }
  const expect = { id: control.id, fingerprint: control.fingerprint }

  if (op === 'CLICK') return { ok: true, action: { operation: op, spec: { action: 'click', index: control.id }, targetId: control.id, expect } }
  if (!isFieldOperation(op)) return { ok: false, reason: `unknown operation ${String(op)}` }
  if (d.valueKey === undefined || !Object.prototype.hasOwnProperty.call(values, d.valueKey))
    return { ok: false, reason: `"${d.valueKey ?? '?'}" is not a provided value` }
  const text = values[d.valueKey]
  const spec: ControlSpec =
    op === 'TYPE_TEXT' ? { action: 'type', index: control.id, text, clear: true } : { action: 'select', index: control.id, value: text }
  return { ok: true, action: { operation: op, spec, targetId: control.id, valueKey: d.valueKey, expect } }
}
