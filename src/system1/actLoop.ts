// The Act tool's step loop, pure over injected effects, built on the
// candidate-action layer: observe (observation.ts) → build the finite space
// (candidates.ts) → ask the policy (policy.ts; Von via vonPolicy.ts) → validate
// membership (validate.ts) → execute → record the result. The policy chooses
// from a CLOSED set each step — an operation, a control id, a value KEY — and
// never produces text, a URL or a navigation. Execution is delegated to
// `execute`, which in production is ControlPage's own controlStep: every
// point-of-no-return card, park and origin-drift check applies unchanged,
// plus the fingerprint revalidation a ValidatedAction carries.
import type { PageSnapshot } from '../platform/domIndex'
import { buildObservation, clip } from './observation'
import { buildCandidateSpace, isElementOperation, isFieldOperation, type BrowserOperation, type CandidateActionSpace, type ElementOperation } from './candidates'
import { PolicyInputError, type BlockedReason, type BrowserDecision, type BrowserPolicy, type StepLike } from './policy'
import { validateDecision, type ValidatedAction } from './validate'

export { opFor } from './observation'
export { TARGET_CHUNK } from './vonPolicy'

export const ACT_DEFAULT_STEPS = 6
export const ACT_MAX_STEPS = 8
export const ACT_CONFIDENCE = 0.6

export type ActStatus = 'done' | 'blocked' | 'uncertain' | 'denied' | 'drifted' | 'repeat' | 'aborted' | 'capped' | 'error' | 'parked'
export type ExecOutcome =
  | { kind: 'ok'; elements: string }
  | { kind: 'denied' }
  | { kind: 'parked'; note: string }
  | { kind: 'drifted'; message: string; elements?: string }
  | { kind: 'error'; message: string }
  /** The page no longer agrees with what the policy saw at that index — nothing was touched. */
  | { kind: 'stale' }

export interface ActStep extends StepLike {
  /** The step's confidence: the minimum over the heads that were asked. */
  p: number
  /** The policy's own inference time for this step. */
  ms: number
}

/** One step's full record for the eval and a future dataset (doc §49). Carries page text — never persisted in-product. */
export interface ActTransition {
  seq: number
  observation: { url: string; title: string; hash: string; controls: number; canScrollDown: boolean; canScrollUp: boolean }
  space: { operations: BrowserOperation[]; targets: Record<ElementOperation, number[]>; shown: number[]; stats: CandidateActionSpace['stats'] }
  decision: BrowserDecision
  action?: { operation: BrowserOperation; targetId?: number; targetName?: string; valueKey?: string }
  result?: 'success' | 'no_change' | 'stale' | 'denied' | 'parked' | 'drifted' | 'error' | 'rejected' | 'repeat'
  ms: { observe: number; policy: number; execute: number }
}

export interface ActResult {
  status: ActStatus
  steps: ActStep[]
  candidates?: { index: number; label: string; p: number }[]
  message?: string
  elements?: string
  blockedReason?: BlockedReason
}
export interface ActRun extends ActResult {
  transitions: ActTransition[]
}

export interface ActDeps {
  snapshot(): Promise<PageSnapshot>
  policy: BrowserPolicy
  execute(action: ValidatedAction): Promise<ExecOutcome>
  aborted(): boolean
  /** Injectable clock for the transition timings. */
  now?: () => number
}

const round = (p: number) => Math.round(p * 100) / 100

export async function runActLoop(
  input: { goal: string; values?: Record<string, string>; maxSteps?: number },
  deps: ActDeps,
): Promise<ActRun> {
  const values = input.values ?? {}
  const cap = Math.max(1, Math.min(ACT_MAX_STEPS, input.maxSteps ?? ACT_DEFAULT_STEPS))
  const now = deps.now ?? (() => Date.now())
  const steps: ActStep[] = []
  const transitions: ActTransition[] = []
  // Loop detection (doc §40): a (page hash, operation, target) seen before in
  // this call is not executed a second time. Hash-aware, so typing a second
  // value into the same field (the page changed) is not a repeat, while a
  // click that changed nothing is.
  const seen = new Set<string>()
  const fin = (r: ActResult): ActRun => ({ ...r, transitions })
  let lastElements: string | undefined
  /** The observation hash BEFORE the last successful action — equal to the next hash means that action changed nothing. */
  let lastHash: string | undefined
  let consecutiveStale = 0

  for (let n = 0; n < cap; n++) {
    if (n > 0 && deps.aborted()) return fin({ status: 'aborted', steps, elements: lastElements })
    const t0 = now()
    let snap: PageSnapshot
    try {
      snap = await deps.snapshot()
    } catch (err) {
      return fin({ status: 'error', steps, message: `could not read the page: ${err instanceof Error ? err.message : String(err)}` })
    }
    const obs = buildObservation(snap)
    const observeMs = now() - t0
    if (lastHash !== undefined && obs.hash === lastHash) {
      const last = steps[steps.length - 1]
      if (last && last.result === 'success') {
        last.result = 'no_change'
        const lt = transitions[transitions.length - 1]
        if (lt) lt.result = 'no_change'
      }
    }
    const space = buildCandidateSpace({ goal: input.goal, observation: obs, values, history: steps })
    const byId = new Map(obs.controls.map((c) => [c.id, c]))
    const nameOf = (id: number) => clip(byId.get(id)?.name || '(unnamed)', 60)

    const t1 = now()
    let decision: BrowserDecision
    try {
      decision = await deps.policy.decide({ goal: input.goal, observation: obs, space, values, steps, threshold: ACT_CONFIDENCE })
    } catch (err) {
      if (err instanceof PolicyInputError) return fin({ status: 'uncertain', steps, message: err.message, elements: snap.text })
      return fin({ status: 'error', steps, message: `System-1 engine failed: ${err instanceof Error ? err.message : String(err)}` })
    }
    const transition: ActTransition = {
      seq: n + 1,
      observation: { url: obs.page.url, title: obs.page.title, hash: obs.hash, controls: obs.controls.length, canScrollDown: obs.state.canScrollDown, canScrollUp: obs.state.canScrollUp },
      space: { operations: space.operations, targets: space.targets, shown: space.shown, stats: space.stats },
      decision,
      ms: { observe: observeMs, policy: now() - t1, execute: 0 },
    }
    transitions.push(transition)

    if (decision.confidence.operation < ACT_CONFIDENCE)
      return fin({ status: 'uncertain', steps, message: `unsure of the next operation (p=${decision.confidence.operation.toFixed(2)})`, elements: snap.text })
    if (decision.operation === 'DONE') return fin({ status: 'done', steps, elements: snap.text })
    if (decision.operation === 'BLOCKED') return fin({ status: 'blocked', steps, elements: snap.text, blockedReason: decision.blockedReason })

    let p = decision.confidence.operation
    if (isElementOperation(decision.operation)) {
      const tp = decision.confidence.target
      if (tp === undefined || tp < ACT_CONFIDENCE) {
        return fin({
          status: 'uncertain', steps, elements: snap.text,
          message: `unsure which control to use (p=${(tp ?? 0).toFixed(2)})`,
          candidates: (decision.ranked ?? []).map((r) => ({ index: r.id, label: byId.get(r.id)?.name ?? '', p: r.p })),
        })
      }
      p = Math.min(p, tp)
      if (isFieldOperation(decision.operation)) {
        const vp = decision.confidence.value
        if (vp === undefined || vp < ACT_CONFIDENCE)
          return fin({ status: 'uncertain', steps, elements: snap.text, message: `unsure which value belongs in "${nameOf(decision.targetId ?? -1)}"` })
        p = Math.min(p, vp)
      }
    }

    const v = validateDecision(decision, space, obs, values)
    if (!v.ok) {
      transition.result = 'rejected'
      return fin({ status: 'error', steps, message: `System-1 returned an action outside the candidate space (${v.reason})` })
    }
    const action: ValidatedAction = v.action
    const label = action.targetId !== undefined ? nameOf(action.targetId) : undefined
    transition.action = { operation: action.operation, targetId: action.targetId, targetName: label, valueKey: action.valueKey }

    const key = `${obs.hash}|${action.operation}|${action.targetId ?? ''}`
    if (seen.has(key)) {
      transition.result = 'repeat'
      return fin({
        status: 'repeat', steps, elements: snap.text,
        message: `would repeat ${action.operation}${action.targetId !== undefined ? ` on [${action.targetId}]` : ''} on an unchanged page`,
      })
    }
    seen.add(key)

    const t2 = now()
    const out = await deps.execute(action)
    transition.ms.execute = now() - t2
    const step: ActStep = { operation: action.operation, targetId: action.targetId, label, valueKey: action.valueKey, result: 'success', p: round(p), ms: decision.ms }
    if (out.kind === 'stale') {
      transition.result = 'stale'
      steps.push({ ...step, result: 'stale' })
      lastHash = undefined
      if (++consecutiveStale >= 2)
        return fin({ status: 'error', steps, message: 'the page kept changing between reading it and acting; re-read it and continue with ControlPage' })
      continue
    }
    consecutiveStale = 0
    if (out.kind === 'denied') { transition.result = 'denied'; return fin({ status: 'denied', steps }) }
    if (out.kind === 'parked') { transition.result = 'parked'; return fin({ status: 'parked', steps, message: out.note }) }
    if (out.kind === 'drifted') { transition.result = 'drifted'; return fin({ status: 'drifted', steps, message: out.message, elements: out.elements }) }
    if (out.kind === 'error') { transition.result = 'error'; return fin({ status: 'error', steps, message: out.message }) }
    transition.result = 'success'
    steps.push(step)
    lastHash = obs.hash
    lastElements = out.elements
  }
  return fin({ status: 'capped', steps, elements: lastElements })
}
