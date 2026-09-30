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
import { buildCandidateSpace, isElementOperation, isFieldOperation, withoutTarget, type BrowserOperation, type CandidateActionSpace, type ElementOperation } from './candidates'
import { PolicyInputError, type BlockedReason, type BrowserDecision, type BrowserPolicy, type StepLike } from './policy'
import { validateDecision, type ValidatedAction } from './validate'

export { opFor } from './observation'
export { TARGET_CHUNK } from './vonPolicy'

export const ACT_DEFAULT_STEPS = 6
export const ACT_MAX_STEPS = 8
/** At or above this calibrated top (per head asked) the step executes freely. */
export const ACT_CONFIDENCE = 0.6
/**
 * Between this and ACT_CONFIDENCE the step is TENTATIVE: it executes only if
 * the executor finds it is not a point of no return (a wrong non-committing
 * click on the granted page is the accepted worst case, undoable via the
 * journal — jev-ultrafast executes the argmax unconditionally and leans on
 * freshness + no-progress + verification instead). Below it the loop hands
 * back. Terminal answers (DONE/BLOCKED) always need ACT_CONFIDENCE: a claim
 * the chat model will act on deserves the higher bar. Measured 2026-09-27 on
 * the fine-tune: the 0.4→0.6 band adds 11 points of coverage for one more
 * confident-but-wrong target out of 54.
 */
export const ACT_TRY_CONFIDENCE = 0.4
/** jev-ultrafast's stop rule: this many consecutive non-WAIT actions that changed nothing end the call. */
export const NO_PROGRESS_STEPS = 3

export type ActStatus = 'done' | 'blocked' | 'uncertain' | 'denied' | 'drifted' | 'repeat' | 'aborted' | 'capped' | 'error' | 'parked'
export type ExecOutcome =
  /** `snapshot` is the executor's own post-action read; when present the loop observes from it instead of reading the page again. */
  | { kind: 'ok'; elements: string; snapshot?: PageSnapshot }
  /** A tentative (below-ACT_CONFIDENCE) action turned out to be a point of no return — nothing was touched. */
  | { kind: 'uncertain'; message: string }
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
  /** The step's second decision, after its first would have repeated and that (operation, target) was excluded from the space. */
  retry?: true
  observation: { url: string; title: string; hash: string; controls: number; canScrollDown: boolean; canScrollUp: boolean }
  space: { operations: BrowserOperation[]; targets: Record<ElementOperation, number[]>; shown: number[]; stats: CandidateActionSpace['stats'] }
  decision: BrowserDecision
  action?: { operation: BrowserOperation; targetId?: number; targetName?: string; valueKey?: string }
  result?: 'success' | 'no_change' | 'stale' | 'denied' | 'parked' | 'drifted' | 'error' | 'rejected' | 'repeat' | 'uncertain'
  ms: { observe: number; policy: number; execute: number }
}

export interface ActResult {
  status: ActStatus
  steps: ActStep[]
  candidates?: { index: number; label: string; p: number }[]
  message?: string
  elements?: string
  blockedReason?: BlockedReason
  /** With `blocked`/MISSING_USER_DATA: the field the policy says lacks a value, so the caller can supply it and call again. */
  missingField?: { index: number; label: string }
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
  /** The executor's post-action snapshot, when it gave one: the next observation, without a third page read per action. */
  let pending: PageSnapshot | undefined

  for (let n = 0; n < cap; n++) {
    if (n > 0 && deps.aborted()) return fin({ status: 'aborted', steps, elements: lastElements })
    const t0 = now()
    let snap: PageSnapshot
    try {
      snap = pending ?? (await deps.snapshot())
      pending = undefined
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
    // No progress: the last NO_PROGRESS_STEPS actions all left the page as it
    // was. A WAIT that changes nothing is what a loading page looks like and
    // does not count; anything else repeated that often is a loop the
    // hash-repeat rule below cannot see (each step a *different* futile action).
    const recent = steps.slice(-NO_PROGRESS_STEPS)
    if (recent.length === NO_PROGRESS_STEPS && recent.every((s) => s.result === 'no_change' && s.operation !== 'WAIT'))
      return fin({ status: 'repeat', steps, elements: snap.text, message: `${NO_PROGRESS_STEPS} actions in a row changed nothing on the page` })
    let space = buildCandidateSpace({ goal: input.goal, observation: obs, values, history: steps })
    const byId = new Map(obs.controls.map((c) => [c.id, c]))
    const nameOf = (id: number) => clip(byId.get(id)?.name || '(unnamed)', 60)

    // One step may decide twice: when the first decision would be a repeat,
    // that (operation, target) is excluded from the space and the policy is
    // asked once more — the harness owns the action space, so "not that one
    // again" is a change to the options, not a hope about the model. Measured
    // 2026-09-30 (run A): every form call typed one value and then chose the
    // same field again, and ending the call there cost a chat-model turn per
    // field.
    let decision: BrowserDecision
    let transition: ActTransition
    let action: ValidatedAction
    let p: number
    let repeatMsg = ''
    const candidates = () => (decision.ranked ?? []).map((r) => ({ index: r.id, label: byId.get(r.id)?.name ?? '', p: r.p }))
    for (let attempt = 0; ; attempt++) {
    const t1 = now()
    try {
      decision = await deps.policy.decide({ goal: input.goal, observation: obs, space, values, steps, threshold: ACT_TRY_CONFIDENCE })
    } catch (err) {
      if (err instanceof PolicyInputError) return fin({ status: 'uncertain', steps, message: err.message, elements: snap.text })
      return fin({ status: 'error', steps, message: `System-1 engine failed: ${err instanceof Error ? err.message : String(err)}` })
    }
    transition = {
      seq: n + 1,
      ...(attempt > 0 ? { retry: true as const } : {}),
      observation: { url: obs.page.url, title: obs.page.title, hash: obs.hash, controls: obs.controls.length, canScrollDown: obs.state.canScrollDown, canScrollUp: obs.state.canScrollUp },
      space: { operations: space.operations, targets: space.targets, shown: space.shown, stats: space.stats },
      decision,
      ms: { observe: attempt === 0 ? observeMs : 0, policy: now() - t1, execute: 0 },
    }
    transitions.push(transition)

    const pOp = decision.confidence.operation
    if (pOp < ACT_TRY_CONFIDENCE)
      return fin({ status: 'uncertain', steps, message: `unsure of the next operation (p=${pOp.toFixed(2)})`, elements: snap.text, candidates: candidates() })
    if (decision.operation === 'DONE') {
      if (pOp < ACT_CONFIDENCE) return fin({ status: 'uncertain', steps, message: `possibly done (p=${pOp.toFixed(2)}) — verify the page`, elements: snap.text })
      return fin({ status: 'done', steps, elements: snap.text })
    }
    if (decision.operation === 'BLOCKED') {
      if (pOp < ACT_CONFIDENCE) return fin({ status: 'uncertain', steps, message: `possibly blocked (p=${pOp.toFixed(2)})`, elements: snap.text })
      const missing = decision.missingFieldId
      const missingField = missing !== undefined && byId.has(missing) ? { index: missing, label: nameOf(missing) } : undefined
      return fin({
        status: 'blocked', steps, elements: snap.text, blockedReason: decision.blockedReason, missingField,
        message: missingField ? `needs a value for [${missingField.index}] "${missingField.label}" — pass it in values and call Act again` : undefined,
      })
    }

    p = pOp
    if (isElementOperation(decision.operation)) {
      const tp = decision.confidence.target
      if (tp === undefined || tp < ACT_TRY_CONFIDENCE)
        return fin({ status: 'uncertain', steps, elements: snap.text, message: `unsure which control to use (p=${(tp ?? 0).toFixed(2)})`, candidates: candidates() })
      p = Math.min(p, tp)
      if (isFieldOperation(decision.operation)) {
        const vp = decision.confidence.value
        if (vp === undefined || vp < ACT_TRY_CONFIDENCE)
          return fin({ status: 'uncertain', steps, elements: snap.text, message: `unsure which value belongs in "${nameOf(decision.targetId ?? -1)}"` })
        p = Math.min(p, vp)
      }
    }

    const v = validateDecision(decision, space, obs, values)
    if (!v.ok) {
      transition.result = 'rejected'
      // A retry that ignored the narrowed space is the original repeat, not a new error.
      if (attempt > 0) return fin({ status: 'repeat', steps, elements: snap.text, message: repeatMsg })
      return fin({ status: 'error', steps, message: `System-1 returned an action outside the candidate space (${v.reason})` })
    }
    action = v.action
    // Below ACT_CONFIDENCE the executor may only run it if it is not a point
    // of no return; it reports `uncertain` otherwise and touches nothing.
    if (p < ACT_CONFIDENCE) action.tentative = true
    transition.action = { operation: action.operation, targetId: action.targetId, targetName: action.targetId !== undefined ? nameOf(action.targetId) : undefined, valueKey: action.valueKey }

    // Two loop rules, both needed. (1) Same (page hash, operation, target) as
    // an earlier step: the page did not change and the policy wants the same
    // thing again. (2) The SAME element action twice in a row even though the
    // page changed — measured 2026-09-27: after one "Add to cart" the cart
    // badge changed the hash, the policy never answered DONE, and it clicked
    // the same button five times (five approval cards, five items). The one
    // legitimate consecutive repeat is a different value into the same field,
    // so the value key is part of the identity; a stale step does not count,
    // since retrying the target on a fresh read is the point of `stale`.
    // (3) WAIT is exempt from the hash rule — waiting on a page that has not
    // changed yet is the whole point of WAIT — but not unbounded: a third
    // consecutive WAIT that changed nothing is a loop, not loading.
    const key = `${obs.hash}|${action.operation}|${action.targetId ?? ''}`
    const prev = steps[steps.length - 1]
    const consecutive =
      prev !== undefined && prev.result !== 'stale' && action.targetId !== undefined &&
      prev.operation === action.operation && prev.targetId === action.targetId && prev.valueKey === action.valueKey
    const waitedOut =
      action.operation === 'WAIT' && steps.length >= 2 && steps.slice(-2).every((s) => s.operation === 'WAIT' && s.result === 'no_change')
    if ((action.operation !== 'WAIT' && seen.has(key)) || consecutive || waitedOut) {
      transition.result = 'repeat'
      repeatMsg = waitedOut
        ? 'waited twice and the page did not change'
        : `would repeat ${action.operation}${action.targetId !== undefined ? ` on [${action.targetId}]` : ''}${consecutive ? ' twice in a row' : ' on an unchanged page'}`
      if (attempt === 0 && action.targetId !== undefined && isElementOperation(action.operation)) {
        space = withoutTarget(space, action.operation, action.targetId)
        continue
      }
      return fin({ status: 'repeat', steps, elements: snap.text, message: repeatMsg })
    }
    seen.add(key)
    break
    }
    const label = action.targetId !== undefined ? nameOf(action.targetId) : undefined

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
    if (out.kind === 'uncertain') {
      transition.result = 'uncertain'
      return fin({ status: 'uncertain', steps, elements: snap.text, message: `${out.message} (p=${p.toFixed(2)})`, candidates: candidates() })
    }
    if (out.kind === 'denied') { transition.result = 'denied'; return fin({ status: 'denied', steps }) }
    if (out.kind === 'parked') { transition.result = 'parked'; return fin({ status: 'parked', steps, message: out.note }) }
    if (out.kind === 'drifted') { transition.result = 'drifted'; return fin({ status: 'drifted', steps, message: out.message, elements: out.elements }) }
    if (out.kind === 'error') { transition.result = 'error'; return fin({ status: 'error', steps, message: out.message }) }
    transition.result = 'success'
    steps.push(step)
    lastHash = obs.hash
    lastElements = out.elements
    pending = out.snapshot
  }
  return fin({ status: 'capped', steps, elements: lastElements })
}
