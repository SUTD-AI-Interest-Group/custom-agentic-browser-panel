// Driver mode's step loop (spec §7.3): the on-device decision model takes a short run of page
// steps toward ONE sub-goal, inside a page-control session the user already granted, and hands
// back to the chat model the moment it is done, unsure, blocked or out of steps.
//
// PURE OVER INJECTED EFFECTS. Every page read, decision, approval card and action is a dependency
// (FastSteps in src/tools/tools.ts supplies the real ones), so each gate and stop rule below is a
// unit test rather than a browser run. It imports nothing at runtime: FastSteps executes in the
// service worker, whose bundle must never reach the panel-only engine (driverLoop.test.ts).
//
// The order of one step, and why:
//  1. guards — Stop, a steer, the session, the tab in front, the origin. Checked before the page is
//     read, and again right before acting: a decision takes long enough for the user to switch tabs.
//  2. snapshot + viewport text, read BEFORE anything acts, so the decision describes this page.
//  3. dense pages come back from `decide` as `{ dense }` — the worker counts the tokens, and a pass
//     over the cap is refused there instead of run slowly.
//  4. decide.
//  5. the banded gate October measured (a0df0e2^:src/system1/actLoop.ts): at or above the threshold
//     a step acts; between 0.4 and the threshold it acts only if it is NOT a point of no return;
//     below 0.4 it hands back. `done` always needs the full threshold — the chat model will act
//     on that claim.
//  6. repeat exclusion: the same (op, index) as the last action, after that action changed
//     nothing, excludes the pair and asks once more — "not that one again" is a change to the
//     options, not a hope about the model.
//  7. a `type` needs a value the panel chose with confidence; otherwise hand back.
//  8. a point of no return gets the one-shot card, then the stale-element re-check (the card
//     described the element as it was before the human's reaction time).
//  9. act — a quick settle for a step that commits nothing, the full one otherwise.
// 10. stop on done, two refused actions, three no-change actions in a row, maxSteps, Stop or steer.
//
// No state outlives one call; the session's journal (appended by runControlStep) is the record.

import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import type { ControlSpec } from '../tools/pageControl'

export const DRIVER_MAX_STEPS = 12
/** Below this the loop hands back; between it and the act threshold a step is tentative. */
export const DRIVER_TRY_THRESHOLD = 0.4
/** Actions the page refused before the call gives up (each refused pair is excluded first). */
export const DRIVER_MAX_FAILED = 2
/** Successful actions in a row that left the page as it was. */
export const DRIVER_NO_CHANGE_STEPS = 3

/** The decider's operations: its next-action options (state.ts's OptionAction) by op name. */
export type DriverOp = 'click' | 'type' | 'select' | 'scroll' | 'done'
export interface OpRef {
  op: DriverOp
  index?: number
}
export interface DriverOption extends OpRef {
  p: number
}

export interface DriverDecision {
  /** Best first. */
  top3: DriverOption[]
  tokens: number
  /** Decider time for this step (the next-action pass, plus the value pass for a `type`). */
  ms: number
  /** For a `type`: what to type, when the panel chose a lookup key with confidence. */
  value?: { key: string; text: string; p: number }
  /** The user queued a steer: stop at this step boundary. */
  steerPending?: boolean
}
export interface DriverDecideError {
  error: string
  /** The pass was over the dense-page cap. */
  dense?: boolean
  steerPending?: boolean
}
export type DriverDecideOutcome = DriverDecision | DriverDecideError

export type DriverStatus = 'done' | 'handback' | 'blocked' | 'stopped'
export type DriverReason =
  | 'done'
  | 'unsure'
  | 'dense page'
  | 'needs value'
  | 'denied'
  | 'repeat'
  | 'failed actions'
  | 'no progress'
  | 'max steps'
  | 'stopped'
  | 'steer'
  | 'session ended'
  | 'parked'
  | 'page moved'
  | 'page changed'
  | 'unreadable page'
  | 'decider error'

/** Why the loop must not take another step. */
export interface DriverStop {
  status: DriverStatus
  reason: DriverReason
  message?: string
}

export interface DriverActOutcome {
  ok: boolean
  message: string
  /** The element registry after the action. */
  registry: string
  /** Set when the action took the page to another origin: that host. */
  moved?: string
}

/** One executed step, as Task 17 scores it: numbers and an op, never page content. */
export interface DriverStepRecord extends OpRef {
  p: number
  ms: number
  ok: boolean
}

export interface DriverResult extends DriverStop {
  /** The freshest element registry the loop saw. */
  elements?: string
  /** The decision a hand-back was made on, so the chat model sees why. */
  lastDecision?: DriverOption[]
  steps: DriverStepRecord[]
  /** Decisions made (a repeat's re-ask counts), and their total time. */
  decisions: number
  deciderMs: number
}

export interface DriverDeps {
  maxSteps: number
  /** The act threshold (settings.decider.actThreshold, default 0.6). */
  threshold: number
  aborted(): boolean
  /** Session, foreground and origin-drift checks: `null` to go on. */
  guard(): Promise<DriverStop | null>
  snapshot(): Promise<PageSnapshot>
  /** The viewport text, read before acting; `null` when the read failed. Must not reject. */
  readPageText(): Promise<string | null>
  decide(i: { snap: PageSnapshot; pageText: string | null; exclude: OpRef[] }): Promise<DriverDecideOutcome>
  isPointOfNoReturn(spec: ControlSpec, el: IndexedElement | undefined): boolean
  /** The one-shot approval card. */
  approve(spec: ControlSpec, el: IndexedElement | undefined): Promise<boolean>
  hasElementChanged(before: IndexedElement | undefined, after: IndexedElement | undefined): boolean
  act(spec: ControlSpec, snap: PageSnapshot, o: { settle: 'quick' | 'full'; approved: boolean }): Promise<DriverActOutcome>
}

const round = (p: number) => Math.round(p * 100) / 100
const sameRef = (a: OpRef, b: OpRef) => a.op === b.op && a.index === b.index
const refOf = (o: OpRef): OpRef => (o.index === undefined ? { op: o.op } : { op: o.op, index: o.index })
const shown = (o: DriverOption): DriverOption => ({ ...refOf(o), p: round(o.p) })
const target = (o: OpRef) => (o.index === undefined ? o.op : `${o.op} [${o.index}]`)
const findEl = (snap: PageSnapshot, index: number | undefined) => (index === undefined ? undefined : snap.elements.find((e) => e.index === index))

/** What the page looks like for "did that action change anything": address, registry, text. */
const fingerprint = (snap: PageSnapshot, pageText: string | null) => `${snap.url}\u0000${snap.text}\u0000${pageText ?? ''}`

/** The action a decision names. Only `type` carries text; `select` and `done` never reach here. */
function specOf(o: OpRef, text?: string): ControlSpec {
  if (o.op === 'scroll') return { action: 'scroll', direction: 'down' }
  if (o.op === 'type') return { action: 'type', index: o.index, text: text ?? '', clear: true }
  return { action: 'click', index: o.index }
}

export async function runDriverLoop(deps: DriverDeps): Promise<DriverResult> {
  const maxSteps = Math.max(1, Math.min(DRIVER_MAX_STEPS, Math.floor(Number.isFinite(deps.maxSteps) ? deps.maxSteps : DRIVER_MAX_STEPS)))
  const steps: DriverStepRecord[] = []
  let decisions = 0
  let deciderMs = 0
  let elements: string | undefined
  let lastDecision: DriverOption[] | undefined
  /** Refused pairs, excluded for the rest of the call. */
  const refused: OpRef[] = []
  let failed = 0
  let noChange = 0
  /** The last successful action, and the page as it was before it. */
  let prev: { ref: OpRef; before: string; changed?: boolean } | null = null

  const end = (stop: DriverStop, withDecision = false): DriverResult => ({
    status: stop.status,
    reason: stop.reason,
    ...(stop.message ? { message: stop.message } : {}),
    ...(elements !== undefined ? { elements } : {}),
    ...(withDecision && lastDecision ? { lastDecision } : {}),
    steps,
    decisions,
    deciderMs,
  })
  const STOPPED: DriverStop = { status: 'stopped', reason: 'stopped', message: 'The turn was stopped.' }
  const STEER: DriverStop = { status: 'stopped', reason: 'steer', message: 'The user sent a new instruction; read it before continuing.' }

  for (let n = 0; ; n++) {
    // 1. Guards, at the step boundary.
    if (deps.aborted()) return end(STOPPED)
    if (n >= maxSteps) return end({ status: 'handback', reason: 'max steps', message: `Took ${n} steps; re-read the page and continue.` })
    const blocked = await deps.guard()
    if (blocked) return end(blocked)

    // 2. The page, before anything acts on it.
    let snap: PageSnapshot
    try {
      snap = await deps.snapshot()
    } catch (err) {
      return end({ status: 'handback', reason: 'unreadable page', message: `Could not read the page (${err instanceof Error ? err.message : String(err)}).` })
    }
    elements = snap.text
    let pageText: string | null = null
    try {
      pageText = await deps.readPageText()
    } catch {
      pageText = null
    }
    const before = fingerprint(snap, pageText)
    if (prev) {
      prev.changed = prev.before !== before
      noChange = prev.changed ? 0 : noChange + 1
    }
    if (noChange >= DRIVER_NO_CHANGE_STEPS)
      return end({ status: 'handback', reason: 'no progress', message: `${noChange} actions in a row changed nothing on the page.` })

    // 3–7. Decide, gate, and on a repeat exclude that pair and ask once more.
    const exclude: OpRef[] = refused.map(refOf)
    let top: DriverOption | undefined
    let decision: DriverDecision | undefined
    let por = false
    for (let attempt = 0; ; attempt++) {
      const out = await deps.decide({ snap, pageText, exclude: exclude.map(refOf) })
      if (deps.aborted()) return end(STOPPED)
      if (out.steerPending) return end(STEER)
      if ('error' in out) {
        if (out.dense) return end({ status: 'handback', reason: 'dense page', message: 'This page is too dense for the decision model; continue with ControlPage.' })
        return end({ status: 'handback', reason: 'decider error', message: out.error })
      }
      decisions++
      deciderMs += out.ms
      lastDecision = out.top3.map(shown)
      const best = out.top3[0]
      if (!best) return end({ status: 'handback', reason: 'decider error', message: 'The decision model returned no options.' })

      // 5. The gate.
      if (best.op === 'done') {
        if (best.p >= deps.threshold) return end({ status: 'done', reason: 'done' }, true)
        return end({ status: 'handback', reason: 'unsure', message: `Possibly done (p=${best.p.toFixed(2)}); check the page.` }, true)
      }
      if (best.p < DRIVER_TRY_THRESHOLD)
        return end({ status: 'handback', reason: 'unsure', message: `Unsure of the next step (p=${best.p.toFixed(2)}).` }, true)
      por = deps.isPointOfNoReturn(specOf(best), findEl(snap, best.index))
      if (best.p < deps.threshold && por)
        return end({ status: 'handback', reason: 'unsure', message: `Not sure enough (p=${best.p.toFixed(2)}) for a risky step: ${target(best)}.` }, true)

      // 6. A repeat of an action that changed nothing.
      if (prev && prev.changed === false && sameRef(prev.ref, best)) {
        if (attempt === 0) {
          exclude.push(refOf(best))
          continue
        }
        return end({ status: 'handback', reason: 'repeat', message: `Would repeat ${target(best)}, which changed nothing.` }, true)
      }
      top = best
      decision = out
      break
    }

    // 7. A value to type, or a hand-back.
    if (top.op === 'select')
      return end({ status: 'handback', reason: 'needs value', message: `Choose the option in [${top.index}] with ControlPage.` }, true)
    if (top.op === 'type' && !decision.value)
      return end({ status: 'handback', reason: 'needs value', message: `No confident value to type into [${top.index}]; pass it in values or type it with ControlPage.` }, true)
    const spec = specOf(top, decision.value?.text)
    const el = findEl(snap, top.index)

    // 8. A point of no return: the one-shot card, then the stale-element re-check.
    let actSnap = snap
    if (por) {
      let approved: boolean
      try {
        approved = await deps.approve(spec, el)
      } catch (err) {
        if (deps.aborted()) return end(STOPPED)
        throw err
      }
      if (deps.aborted()) return end(STOPPED)
      if (!approved) return end({ status: 'blocked', reason: 'denied', message: 'The user declined this step.' }, true)
      const after = await deps.guard()
      if (after) return end(after)
      try {
        actSnap = await deps.snapshot()
      } catch {
        return end({ status: 'handback', reason: 'page changed', message: 'Could not re-read the page after the approval; re-read it and continue.' })
      }
      elements = actSnap.text
      if (top.index !== undefined && deps.hasElementChanged(el, findEl(actSnap, top.index)))
        return end({ status: 'handback', reason: 'page changed', message: 'The page changed while waiting for approval; re-read it and continue.' })
    } else {
      const now = await deps.guard()
      if (now) return end(now)
    }
    if (deps.aborted()) return end(STOPPED)

    // 9. Act. A link click may load a page, so it waits like a committing step does.
    const settle = por || (top.op === 'click' && !!el?.href) ? 'full' : 'quick'
    const r = await deps.act(spec, actSnap, { settle, approved: por })
    elements = r.registry
    steps.push({ ...refOf(top), p: round(top.p), ms: decision.ms, ok: r.ok })
    if (!r.ok) {
      refused.push(refOf(top))
      prev = null
      if (++failed >= DRIVER_MAX_FAILED)
        return end({ status: 'handback', reason: 'failed actions', message: `The page refused ${failed} actions (last: ${r.message}).` })
      continue
    }
    if (r.moved)
      return end({ status: 'handback', reason: 'page moved', message: `The page is now on ${r.moved}; re-read the elements and continue with ControlPage.` })
    prev = { ref: refOf(top), before }
  }
}
