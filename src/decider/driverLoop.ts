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
//  6. repeat exclusion (spec §3): an immediate repeat of the last action — the same (op, index) on
//     the same page, at an element that has not changed — excludes the pair and asks once more:
//     "not that one again" is a change to the options, not a hope about the model. (A target-less
//     scroll counts only when the last one changed nothing.)
//  7. a `type` or `select` needs a value the panel chose with confidence; otherwise hand back.
//  8. right before acting: a point of no return gets the one-shot card; then the page is re-read,
//     the guards run, the element must still be the one decided on, and it is classified again
//     (a step that became risky is carded, or handed back in the tentative band). The decision
//     and any card took time; nothing acts on a snapshot from before it.
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
  /**
   * For a `type`: the text to type, when the panel chose a lookup key with confidence. For a
   * `select`: the option to choose (one the worker read off that select), likewise.
   */
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
  | 'another FastSteps run is in progress'
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
  /** A `type`/`select`: the lookup key NAME the value came from (`profile.email`, `option.2`) — never the value. */
  key?: string
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

/** A page's address without its fragment: a hash change (`#added`) does not make it another page. */
const pageOf = (url: string) => url.split('#')[0]

/** What the page looks like for "did that action change anything": address, registry, text. */
const fingerprint = (snap: PageSnapshot, pageText: string | null) => `${snap.url}\u0000${snap.text}\u0000${pageText ?? ''}`

/** The action a decision names: `type` carries its text, `select` its option; `done` never gets here. */
function specOf(o: OpRef, text?: string): ControlSpec {
  if (o.op === 'scroll') return { action: 'scroll', direction: 'down' }
  if (o.op === 'type') return { action: 'type', index: o.index, text: text ?? '', clear: true }
  if (o.op === 'select') return { action: 'select', index: o.index, value: text ?? '' }
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
  let prev: { ref: OpRef; before: string; page: string; el: IndexedElement | undefined; changed?: boolean } | null = null

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

      // 5. The gate. Every comparison is written as "act only if p >= x", so a NaN (or any
      // non-number) never clears a bar: `NaN < x` is false, `NaN >= x` is false too.
      if (best.op === 'done') {
        if (best.p >= deps.threshold) return end({ status: 'done', reason: 'done' }, true)
        return end({ status: 'handback', reason: 'unsure', message: `Possibly done (p=${best.p.toFixed(2)}); check the page.` }, true)
      }
      if (!(best.p >= DRIVER_TRY_THRESHOLD))
        return end({ status: 'handback', reason: 'unsure', message: `Unsure of the next step (p=${best.p.toFixed(2)}).` }, true)
      por = deps.isPointOfNoReturn(specOf(best), findEl(snap, best.index))
      if (!(best.p >= deps.threshold) && por)
        return end({ status: 'handback', reason: 'unsure', message: `Not sure enough (p=${best.p.toFixed(2)}) for a risky step: ${target(best)}.` }, true)
      // (Re-classified on the live element right before acting — step 8.)

      // 6. An immediate repeat of the last action's target (spec §3): excluded, and asked once
      // more. An element target repeats when it is the same page (its address, fragment aside)
      // and the same element — clicking "Add to cart" again after the header changed is exactly
      // the repeat October measured (five cards, five items) — even though the page changed. The
      // same INDEX on another page, or at an element that changed, is a different target: indices
      // are reassigned on every page (measured: [5] was a search result, then "Add to cart").
      // A target-less scroll repeats only when the last one changed nothing: scrolling on down a
      // long page is not a loop.
      const repeated =
        prev !== null &&
        sameRef(prev.ref, best) &&
        (best.index === undefined
          ? prev.changed === false
          : prev.page === pageOf(snap.url) && !deps.hasElementChanged(prev.el, findEl(snap, best.index)))
      if (repeated) {
        if (attempt === 0) {
          exclude.push(refOf(best))
          continue
        }
        return end({ status: 'handback', reason: 'repeat', message: `Would repeat ${target(best)} twice in a row.` }, true)
      }
      top = best
      decision = out
      break
    }

    // 7. A value to type or choose, or a hand-back.
    if ((top.op === 'type' || top.op === 'select') && !decision.value) {
      const what = top.op === 'type' ? `No confident value to type into [${top.index}]; pass it in values or type it` : `No confident option to choose in [${top.index}]; choose it`
      return end({ status: 'handback', reason: 'needs value', message: `${what} with ControlPage.` }, true)
    }
    const spec = specOf(top, decision.value?.text)
    let el = findEl(snap, top.index)

    // 8. Right before acting, the target as it stands NOW. The decision (and any card) took time
    // — ~150 ms warm, up to 30 s on a cold first step, a human's reaction time on a card — and a
    // quick settle can leave the page mid-render: a button relabelled in place ("Choose size" →
    // "Buy now") must not be clicked on the strength of what it used to say. So: a point of no
    // return gets its one-shot card first; then, either way, the page is re-read, the guards run
    // (after the read, whose wait for a loading tab can be seconds), the element must be the one
    // decided on, and it is classified again — a step that has BECOME risky is carded (or, in the
    // tentative band, handed back) and re-checked once more before anything acts.
    let actSnap = snap
    let carded = false
    for (;;) {
      if (por && !carded) {
        if (!(top.p >= deps.threshold))
          return end({ status: 'handback', reason: 'unsure', message: `Not sure enough (p=${top.p.toFixed(2)}) for a risky step: ${target(top)}.` }, true)
        let approved: boolean
        try {
          approved = await deps.approve(spec, el)
        } catch (err) {
          if (deps.aborted()) return end(STOPPED)
          throw err
        }
        if (deps.aborted()) return end(STOPPED)
        if (!approved) return end({ status: 'blocked', reason: 'denied', message: 'The user declined this step.' }, true)
        carded = true
      }
      try {
        actSnap = await deps.snapshot()
      } catch {
        return end({ status: 'handback', reason: 'page changed', message: 'Could not re-read the page before acting; re-read it and continue.' })
      }
      elements = actSnap.text
      const now = await deps.guard()
      if (now) return end(now)
      if (deps.aborted()) return end(STOPPED)
      const fresh = findEl(actSnap, top.index)
      // A click on a checkbox/radio is a tick or an untick (state.ts words it so): a box that
      // flipped since the decision would make the same click do the opposite, so its checked
      // state counts as a change here — though not for the repeat rule above, where re-clicking
      // the box just ticked must still read as the repeat it is.
      if (top.index !== undefined && (deps.hasElementChanged(el, fresh) || (top.op === 'click' && el?.checked !== fresh?.checked)))
        return end({
          status: 'handback',
          reason: 'page changed',
          message: carded ? 'The page changed while waiting for approval; re-read it and continue.' : 'The page changed before the step could run; re-read it and continue.',
        })
      el = fresh
      if (!carded && deps.isPointOfNoReturn(spec, el)) {
        por = true
        continue
      }
      break
    }

    // 9. Act. A link click may load a page, so it waits like a committing step does.
    const settle = por || (top.op === 'click' && !!el?.href) ? 'full' : 'quick'
    const r = await deps.act(spec, actSnap, { settle, approved: por })
    elements = r.registry
    steps.push({ ...refOf(top), p: round(top.p), ms: decision.ms, ok: r.ok, ...(decision.value ? { key: decision.value.key } : {}) })
    if (!r.ok) {
      refused.push(refOf(top))
      prev = null
      if (++failed >= DRIVER_MAX_FAILED)
        return end({ status: 'handback', reason: 'failed actions', message: `The page refused ${failed} actions (last: ${r.message}).` })
      continue
    }
    if (r.moved)
      return end({ status: 'handback', reason: 'page moved', message: `The page is now on ${r.moved}; re-read the elements and continue with ControlPage.` })
    prev = { ref: refOf(top), before, page: pageOf(actSnap.url), el }
  }
}
