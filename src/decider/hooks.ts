// The decision model's seat beside page control: in shadow mode it watches each ControlPage
// step, decides what it would have done, and records how that compares with what the LLM did.
//
// TWO REALMS. Under durable chat, tools execute in the service worker (src/background/toolHost.ts)
// and the engine lives here in the panel, so the worker holds a forwarding DeciderHooks
// (relay.ts's `forwardDeciderHooks`) and each step reaches these hooks through `relay()` — a
// chain-scoped runtime listener in runTurnChain (src/ui/Chat.tsx). `observeStep` is the same path
// for a ToolSet that executes in this realm. Both funnel into `shadow()` below.
//
// ADDITIVE BY CONSTRUCTION. Every hook a tool calls is synchronous and returns void: the decision
// runs in a detached task whose every rejection is swallowed, so a step's result can never depend
// on the decider — not on its latency (the WASM fallback takes seconds per decision), not on its
// failure, not on a decision that never settles. The engine is asked with `dropIfBusy`, so a burst
// of steps collapses to the newest instead of queueing.
//
// THE ONE EXCEPTION IS ASSIST. An AutofillForm call without `fields` awaits `mapForm` (locally) or
// `answer()` (the worker's `decider.mapForm` request): profile memories → profileLookup (one cached
// chat-model call) → fillRequest → decide (queued, not dropIfBusy) → planFill. The plan is only a
// list of fills; AutofillForm's own loop still runs every guard on each. `observeFill` shadows a
// call that brought its own fields, like observeStep shadows a step.
//
// DRIVER (FastSteps) is the other awaited path, one request per step (`next` locally, `answer()`
// for the worker's `decider.next`): nextActionRequest minus the excluded pairs → decide (queued,
// capped at DRIVER_MAX_TOKENS so a dense page is handed back instead of decided slowly) → for a
// `type`/`select` at the top, the single-field fill question — over the call's own values first,
// and over profile + values only when those cannot answer (fieldValue). Every decision writes a
// `drive` record (llm and agree null: nothing to compare with), key names only.
//
// Built ONCE per continuation chain, so `seq` numbers every step this chain's hooks were handed —
// recorded, dropped or off alike — and model readiness is probed once per chain.
//
// NO USER DATA IN THE RECORD (shadowStore.ts's rule, after traces.ts). The request handed to the
// engine carries the goal, page text and element names, and never leaves the device: the engine
// is a local worker. The stored ShadowRecord carries op names, indices, numbers and enums only —
// `llm` is built from the spec's action/index alone, never its text/value/url/label, and options
// are mapped back through `actions` (indices), never through their element descriptions.
// hooks.test.ts drives a password through both paths (local and forwarded) to hold that line. A
// fill record holds lookup key NAMES, a select option's position and tick/leave — never a value,
// a label or a typed string (fillKey below).

import type { LanguageModel, ModelMessage } from 'ai'
import { getProfileMemories } from '../data/memory'
import { readSelectOptions, type IndexedElement, type PageSnapshot } from '../platform/domIndex'
import { readViewportText } from '../platform/viewportText'
import type { ControlSession, ControlSpec } from '../tools/pageControl'
import { assistsForms, DRIVER_MAX_TOKENS, MODEL_ID, PAGE_TEXT_CAP, type DeciderMode, type DeciderSettings } from './config'
import type { DriverDecideOutcome, DriverOption, OpRef } from './driverLoop'
import { getDeciderEngine, type DeciderEngine } from './engine'
import { planFill, type FillPlan } from './fillPlan'
import { profileLookup } from './profileLookup'
import type { DecisionResult } from './protocol'
import type { Answer } from './readout'
import type { DecisionRequest } from './request'
import {
  createModeResolver,
  formSnapOf,
  isDeciderOn,
  observedFields,
  parseDeciderRelay,
  parseMapFormRequest,
  parseNextRequest,
  previousActionsOf,
  selectIndicesOf,
  stepOf,
  STOPPED,
  type DecisionStep,
  type FillObservation,
  type FormSnap,
  type MapFormReply,
  type NextReply,
  type NextRequest,
} from './relay'
import { putShadow, type ShadowRecord } from './shadowStore'
import { fillRequest, formFields, nextActionRequest, type FillQuestion, type Lookup, type OptionAction } from './state'
import { isModelReady } from './storage'

/** One FastSteps step, as a decision needs it — what `decider.next` carries, minus its addressing. */
export type NextStep = Omit<NextRequest, 'type' | 'conversationId' | 'requestId'>

export interface DeciderHooks {
  /**
   * 'off' unless the settings say shadow/assist/driver AND the imported model is ready (readiness is
   * probed lazily: 'off' until the probe settles — await `resolveMode()` first where it matters).
   */
  mode(): DeciderMode
  /**
   * Settles once readiness is known — one chrome.storage read, cached for the hooks' life — with
   * `mode()`. Never rejects. Both realms await it before building a ToolSet, so the things decided
   * from `mode()` at build time — FastSteps' presence, AutofillForm's schema and description, the
   * grant notes — agree between the panel's schemas and the worker's tools, and a missing model
   * reads as off everywhere.
   */
  resolveMode(): Promise<DeciderMode>
  /** The settings' mode alone, readiness not consulted. */
  settingsMode(): DeciderMode
  threshold(): number
  /** A page-control session was granted: warm the engine (never awaited; errors swallowed). */
  sessionGranted(): void
  /** Fire-and-forget: shadow one ControlPage step. Never throws, never needs awaiting. */
  observeStep(i: { tabId: number; snap: PageSnapshot; spec: ControlSpec; session: ControlSession }): void
  /**
   * Fire-and-forget: shadow an AutofillForm call that brought its own `fields` — what would the
   * decider have typed into each? Never throws, never needs awaiting. Sensitive fields are ignored.
   */
  observeFill(i: { tabId: number; snap: PageSnapshot; session: ControlSession; fields: { index: number; value: string; sensitive?: boolean }[] }): void
  /**
   * Assist: map the form's fields from the user's profile plus the request's own `values`. Awaited
   * by AutofillForm; resolves a plan or `{ error }` (a short reason), never rejects. When `signal`
   * aborts (Stop) the wait ends at once with `{ error }`, and a plan that lands later is dropped:
   * neither returned nor recorded.
   */
  mapForm(i: { tabId: number; snap: PageSnapshot; session: ControlSession; values: Record<string, string>; signal?: AbortSignal }): Promise<FillPlan | { error: string }>
  /**
   * Driver: decide one FastSteps step — the top three next actions on this page, without the
   * `exclude`d pairs, and for a `type` the value to type when one is chosen with confidence.
   * Awaited; resolves a decision or `{ error }` (`dense` when the page is over the dense cap),
   * never rejects, and ends at once with `{ error }` when `signal` aborts.
   */
  next(i: {
    tabId: number
    snap: PageSnapshot
    session: ControlSession
    goal: string
    values: Record<string, string>
    pageText: string | null
    exclude: OpRef[]
    signal?: AbortSignal
  }): Promise<DriverDecideOutcome>
}

/** The panel's hooks: DeciderHooks plus the entry points for messages from the worker. */
export interface DeciderPanelHooks extends DeciderHooks {
  /**
   * Handle one runtime message. Anything that is not a well-formed decider relay message for THIS
   * conversation is ignored. Synchronous and fire-and-forget, like observeStep. Never throws.
   */
  relay(msg: unknown): void
  /**
   * Answer the worker's request — assist's `decider.mapForm` or driver's `decider.next` — for THIS
   * conversation: the reply to hand to sendResponse. `undefined` for anything else — another
   * conversation's request is left for that conversation's own chain to answer. Never throws; the
   * promise never rejects.
   */
  answer(msg: unknown): Promise<MapFormReply | NextReply> | undefined
}

/** The two engine calls the hooks make — a DeciderEngine, or a test double. */
export type DeciderEngineLike = Pick<DeciderEngine, 'decide' | 'warm'>

export interface DeciderHookDeps {
  settings: () => DeciderSettings | undefined
  conversationId: string
  /** The goal the decider is told: the newest user message (so a steer re-aims it). */
  currentGoal: () => string
  /** The chat model, for Task 11's profile structuring call. */
  chatModel: () => LanguageModel | null
  /** Defaults to the panel's singleton (getDeciderEngine). */
  engine?: DeciderEngineLike
  /** Defaults to storage.ts's isModelReady. */
  modelReady?: () => Promise<boolean>
  /**
   * Whether the user has queued a mid-turn steer (runTurnChain's steer queue). Every driver reply
   * carries it, so FastSteps — running in the worker — stops at its next step boundary.
   */
  steerPending?: () => boolean
}

// ---------------------------------------------------------------------------
// The goal
// ---------------------------------------------------------------------------

/**
 * Where the panel's own context begins inside a user message. buildUserTurn (src/ui/Chat.tsx)
 * appends, after what the user typed: the synced tab content (up to 25k characters, on every
 * first message), the "[Open on screen right now: …]" line (on every message), a shared
 * selection, the @memory instruction, and attachment text (attachments.ts / attachmentPlan.ts).
 * None of it is the goal, and the synced tab alone would push most steps past the decider's
 * token cap — so the goal is cut at the earliest of these.
 */
const CONTEXT_MARKERS = [
  '\n\n[Current content of the tab',
  '\n\n[Open on screen right now:',
  '\n\n[The user highlighted this text',
  '\n\n[The user invoked @memory',
  '\n\n[The user attached',
  '\n\n[attachment "',
  '\n\n--- attached file:',
]

function typedPart(text: string): string {
  let cut = text.length
  for (const m of CONTEXT_MARKERS) {
    const at = text.indexOf(m)
    if (at !== -1 && at < cut) cut = at
  }
  return text.slice(0, cut).trim()
}

/**
 * The newest user message's text — string content, or the text parts of a parts array (an image
 * or file part contributes nothing) — with the panel's appended context removed. A steer is
 * spliced into history as an ordinary user message, so it becomes the goal the moment it lands.
 */
export function latestUserText(history: ModelMessage[]): string {
  for (let k = history.length - 1; k >= 0; k--) {
    const m = history[k]
    if (m.role !== 'user') continue
    const text =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
            .map((p) => p.text)
            .join('\n')
    return typedPart(text)
  }
  return ''
}

// ---------------------------------------------------------------------------
// Judging a step
// ---------------------------------------------------------------------------

type Llm = { op: ControlSpec['action']; index?: number }

/**
 * Does the decider's top option match what the LLM did?
 *
 * click/type/select: same op AND same index. A typeable input is offered as `type into [i]`, so
 * the LLM clicking into it counts as a disagreement — the op is part of the decision.
 *
 * scroll: the decider has exactly one scroll option, "scroll down" ("reveal more of the page").
 * A downward scroll (the default direction) agrees iff that option won. An upward scroll or a
 * scroll-to-element is something the decider cannot express, so it is unjudged (`null`), exactly
 * like press/navigate/wait/highlight: counting those as disagreements would charge the decider
 * for options it was never given, and summarize() leaves `null` out of every agreement rate.
 */
function judge(spec: DecisionStep['spec'], top: OptionAction): boolean | null {
  switch (spec.action) {
    case 'click':
    case 'type':
    case 'select':
      return top.op === spec.action && 'index' in top && top.index === spec.index
    case 'scroll':
      return (spec.direction ?? 'down') === 'down' ? top.op === 'scroll' : null
    default:
      return null
  }
}

const entryOf = (a: OptionAction, p: number): ShadowRecord['top3'][number] =>
  'index' in a ? { op: a.op, index: a.index, p } : { op: a.op, p }

/** `too-long: 9000 tokens exceeds 8192` → 9000 (a count, not user data). */
const tooLongTokens = (message: string): number => Number(/^too-long:\s*(\d+)/.exec(message)?.[1] ?? 0)

/** state.ts takes IndexedElements; it never reads their rect. */
const asIndexed = (e: DecisionStep['elements'][number]): IndexedElement => ({ ...e, rect: { x: 0, y: 0, width: 0, height: 0 } })

// ---------------------------------------------------------------------------
// Judging a fill
// ---------------------------------------------------------------------------

/**
 * The record's key for one field's answer — never a value, never free text:
 * - a profile key NAME (`profile.email`: snake_case, normalised by profileLookup), or `leave_empty`;
 * - a request value's POSITION (`request.0`): its name is whatever the chat model chose to call it,
 *   which can be anything at all (the plan itself keeps the real name, in memory, for the mapping);
 * - a select option's POSITION (`option.0`): a label can be user data — a saved-address dropdown
 *   lists the address;
 * - `tick`/`leave` for a checkbox.
 */
function fillKey(q: FillQuestion, a: Answer, requestKeys: string[]): string {
  if (q.field.kind === 'select') return `option.${q.options.indexOf(a.top)}`
  if (q.field.kind === 'checkbox') return a.top === 'true' ? 'tick' : 'leave'
  if (a.top.startsWith('request.')) return `request.${requestKeys.indexOf(a.top.slice('request.'.length))}`
  return a.top
}

const fold = (s: string) => s.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()

/** `s` folded to its words: letters and digits, single-spaced. */
const words = (s: string) => fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * Does one of a select's option labels name one of the request's values — that text, or that text
 * as whole words inside the label ("2" in "2 items", never in "12 items")? Driver mode asks a
 * select over the values alone only then (fieldValue).
 */
function optionNamesValue(options: string[], values: Record<string, string>): boolean {
  const named = Object.values(values).map(words).filter(Boolean)
  return options.some((o) => {
    const label = ` ${words(o)} `
    return named.some((v) => label.includes(` ${v} `))
  })
}

function lookupValue(lookup: Lookup, key: string): string | undefined {
  const [group, ...rest] = key.split('.')
  const k = rest.join('.')
  const table = group === 'profile' ? lookup.profile : group === 'request' ? lookup.request : undefined
  return table && Object.hasOwn(table, k) ? table[k] : undefined
}

/** What the chat model "typed" into a checkbox that reads as leaving it unticked. */
const UNTICKED = /^(?:|false|no|0|off|unchecked|unticked)$/i

/**
 * Would the decider have put the same thing in this field as the chat model did? `null` when the
 * model did not fill the field in this call (it may well do so with ControlPage next), or typed a
 * value the decider was never offered — the same rule as a step's unjudged actions: the decider is
 * not charged for an option it did not have.
 */
function judgeFill(q: FillQuestion, a: Answer, lookup: Lookup, typed: string | undefined): boolean | null {
  if (typed === undefined) return null
  if (q.field.kind === 'checkbox') return (a.top === 'true') === !UNTICKED.test(typed.trim())
  if (q.field.kind === 'select') {
    if (!q.options.some((o) => fold(o) === fold(typed))) return null
    return fold(a.top) === fold(typed)
  }
  const offered = [...Object.values(lookup.profile), ...Object.values(lookup.request)].map(fold)
  if (!offered.includes(fold(typed))) return null
  const decided = a.top === 'leave_empty' ? '' : (lookupValue(lookup, a.top) ?? '')
  return fold(decided) === fold(typed)
}

/** `the form is too long…` / `the decision model failed: …` — the reason AutofillForm reports. */
function decideFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.startsWith('too-long')) return `the form is too long for the decision model (${tooLongTokens(message)} tokens)`
  return `the decision model failed: ${message}`.slice(0, 200)
}

/** A failure with a reason worth handing back as-is. */
class FillError extends Error {}

const NOTHING_TO_FILL = 'no saved profile details and no values to fill from'
/** The reply to a request its worker gave up on (decider.mapForm.cancel). */
const CANCELLED = 'the request was cancelled'

/** Resolves when `signal` aborts (never, without one). */
const whenAborted = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (!signal) return
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })

// ---------------------------------------------------------------------------
// The hooks
// ---------------------------------------------------------------------------

export function createDeciderHooks(deps: DeciderHookDeps): DeciderPanelHooks {
  const engine = (): DeciderEngineLike => deps.engine ?? getDeciderEngine()
  const resolver = createModeResolver(deps.settings, deps.modelReady ?? isModelReady)
  let seq = 0
  // A skipped record still needs a backend; the last one this chain saw is the honest guess
  // (summarize() leaves skipped records out of every latency figure regardless).
  let lastBackend: ShadowRecord['backend'] = 'wasm'
  // The worker's assist requests still being answered, by requestId: a `decider.mapForm.cancel`
  // flips its flag, and planForm checks it before and after the decision.
  const pending = new Map<string, { cancelled: boolean }>()

  const base = (n: number, at: number, llm: ShadowRecord['llm'], kind: ShadowRecord['kind'] = 'next') => ({
    id: crypto.randomUUID(),
    conversationId: deps.conversationId,
    seq: n,
    at,
    kind,
    modelId: MODEL_ID,
    llm,
  })

  function recordOf(n: number, at: number, llm: Llm, spec: DecisionStep['spec'], actions: OptionAction[], result: DecisionResult): ShadowRecord {
    const a = result.answers.next
    if (!a || a.probs.length !== actions.length || a.options.length !== actions.length) {
      throw new Error('the decision does not match the options it was asked')
    }
    const order = a.probs
      .map((_, k) => k)
      .sort((x, y) => a.probs[y] - a.probs[x])
      .slice(0, 3)
    lastBackend = result.backend
    return {
      ...base(n, at, llm),
      tokens: result.tokens,
      ms: result.ms,
      backend: result.backend,
      cold: result.cold,
      top3: order.map((k) => entryOf(actions[k], a.probs[k])),
      agree: judge(spec, actions[order[0]]),
      wouldAct: a.probs[order[0]] >= resolver.threshold(),
    }
  }

  function skippedOf(n: number, at: number, llm: ShadowRecord['llm'], err: unknown, kind: ShadowRecord['kind'] = 'next'): ShadowRecord {
    const message = err instanceof Error ? err.message : String(err)
    const tooLong = message.startsWith('too-long')
    return {
      ...base(n, at, llm, kind),
      tokens: tooLong ? tooLongTokens(message) : 0,
      ms: 0,
      backend: lastBackend,
      cold: false,
      top3: [],
      agree: null,
      wouldAct: false,
      skipped: tooLong ? 'too-long' : 'error',
    }
  }

  async function decideAndRecord(n: number, goal: string, step: DecisionStep): Promise<void> {
    const at = Date.now()
    // A relayed step brings the text the worker read before its action ran; reading it again here
    // would describe the page AFTER the action. Only a step taken in this realm is read here — and
    // then, with readiness already known, before the first await, for the same reason.
    const relayed = step.pageText !== undefined
    const textP = !relayed && resolver.ready() === true ? readViewportText(step.tabId, PAGE_TEXT_CAP) : null
    if (!textP && !(await resolver.resolveReady())) return
    const llm: Llm = step.spec.index === undefined ? { op: step.spec.action } : { op: step.spec.action, index: step.spec.index }
    let record: ShadowRecord
    try {
      let pageText: string
      if (relayed) {
        if (step.pageText === null || step.pageText === undefined) throw new Error('the worker could not read the page')
        pageText = step.pageText
      } else {
        pageText = await (textP ?? readViewportText(step.tabId, PAGE_TEXT_CAP))
      }
      const { request, actions } = nextActionRequest({
        goal,
        plan: step.plan,
        url: step.url,
        title: step.title,
        previousActions: step.previousActions,
        pageText,
        elements: step.elements.map(asIndexed),
      })
      const result = await engine().decide(request, { dropIfBusy: true })
      if (result === null) return // superseded by a newer step's decision: nothing to compare
      record = recordOf(n, at, llm, step.spec, actions, result)
    } catch (err) {
      record = skippedOf(n, at, llm, err)
    }
    await putShadow(record)
  }

  /**
   * The one entry both realms use. `capture` runs synchronously (it snapshots the step before
   * the action runs); everything after is detached. `seq` is taken before any check, so every
   * step this chain was handed has a number.
   */
  function shadow(capture: () => DecisionStep): void {
    const n = seq++
    try {
      if (!isDeciderOn(resolver.settingsMode()) || resolver.ready() === false) return
      const step = capture()
      const goal = deps.currentGoal()
      void decideAndRecord(n, goal, step).catch(() => {})
    } catch {
      /* additive only: a broken decider must never touch the step */
    }
  }

  // -------------------------------------------------------------------------
  // Form filling
  // -------------------------------------------------------------------------

  /**
   * One fill record. `fill` has an entry per field the decider answered; `top3` holds the weakest
   * three of them, so a record's confidence (top3[0].p, which stats.ts calibrates and covers by) is
   * its least sure field — the one that decides whether the whole form agrees. `agree` is every
   * judged field agreeing (`null` when none was judged, as in assist, where the decider acted alone).
   */
  function fillRecordOf(
    n: number,
    at: number,
    llm: ShadowRecord['llm'],
    questions: FillQuestion[],
    result: DecisionResult,
    lookup: Lookup,
    plan: FillPlan,
    typed: Map<number, string> | null,
  ): ShadowRecord {
    const fill: NonNullable<ShadowRecord['fill']> = []
    const requestKeys = Object.keys(lookup.request)
    for (const q of questions) {
      const a = result.answers[q.name]
      if (!a) continue
      fill.push({ index: q.field.index, key: fillKey(q, a, requestKeys), p: a.p, llmAgrees: typed ? judgeFill(q, a, lookup, typed.get(q.field.index)) : null })
    }
    if (fill.length === 0) throw new Error('the decision answered none of the fields it was asked')
    lastBackend = result.backend
    const judged = fill.filter((f) => f.llmAgrees !== null)
    return {
      ...base(n, at, llm, 'fill'),
      tokens: result.tokens,
      ms: result.ms,
      backend: result.backend,
      cold: result.cold,
      top3: [...fill]
        .sort((x, y) => x.p - y.p)
        .slice(0, 3)
        .map((f) => ({ op: 'fill', index: f.index, p: f.p })),
      agree: judged.length ? judged.every((f) => f.llmAgrees === true) : null,
      wouldAct: plan.fills.length > 0,
      fill,
    }
  }

  /** The profile (structured by the chat model, cached) beside the request's own values. */
  async function lookupFor(values: Record<string, string>): Promise<Lookup> {
    const memories = await getProfileMemories()
    if (memories.length === 0) return { profile: {}, request: values }
    const model = deps.chatModel()
    if (!model) throw new FillError('the chat model is unavailable to read the profile')
    try {
      return { profile: await profileLookup(model, memories), request: values }
    } catch (err) {
      throw new FillError(`could not read the profile: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200))
    }
  }

  /**
   * Assist, for both realms: formFields → profileLookup → fillRequest → decide (queued, NOT
   * dropIfBusy: a tool is waiting on this one) → planFill, then a fill record (key names only).
   * `options` is a thunk so that nothing touches the page unless the decider is really in Assist.
   * `cancelled` is the caller giving up (the worker's cancel, or Stop): checked before the decision
   * and again after it, so a plan nobody will apply is neither returned nor recorded — assist
   * stats count only plans that were handed back.
   */
  async function planForm(
    n: number,
    form: { snap: FormSnap },
    options: () => Promise<Record<number, string[]>>,
    values: Record<string, string>,
    cancelled: () => boolean,
  ): Promise<FillPlan | { error: string }> {
    try {
      if (!assistsForms(resolver.settingsMode())) return { error: 'the decision model is not in Assist mode' }
      if (!(await resolver.resolveReady())) return { error: 'the decision model is not ready' }
      const fields = formFields(form.snap.elements.map(asIndexed), await options())
      if (fields.length === 0) return { error: 'no fillable fields on this page' }
      const lookup = await lookupFor(values)
      if (cancelled()) return { error: CANCELLED }
      if (Object.keys(lookup.profile).length === 0 && Object.keys(lookup.request).length === 0) return { error: NOTHING_TO_FILL }
      const { request, questions } = fillRequest({ goal: deps.currentGoal(), url: form.snap.url, title: form.snap.title, lookup, fields })
      const at = Date.now()
      let result: DecisionResult
      try {
        // Not dropIfBusy, so the engine never answers null here (only a dropIfBusy call can be
        // superseded); a null would fail planFill below and come back as an error, unrecorded.
        result = (await engine().decide(request)) as DecisionResult
      } catch (err) {
        if (!cancelled()) void putShadow(skippedOf(n, at, null, err, 'fill')).catch(() => {})
        return { error: cancelled() ? CANCELLED : decideFailure(err) }
      }
      if (cancelled()) return { error: CANCELLED }
      const plan = planFill(questions, result.answers, lookup, resolver.threshold())
      try {
        void putShadow(fillRecordOf(n, at, null, questions, result, lookup, plan, null)).catch(() => {})
      } catch {
        /* the record is a log; the plan stands */
      }
      return plan
    } catch (err) {
      if (err instanceof FillError) return { error: err.message }
      return { error: `the decision model failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) }
    }
  }

  async function observeAndRecord(n: number, goal: string, obs: Omit<FillObservation, 'selectOptions'>, optionsP: Promise<Record<number, string[]>>): Promise<void> {
    if (!(await resolver.resolveReady())) return
    const fields = formFields(obs.snap.elements.map(asIndexed), await optionsP)
    if (fields.length === 0) return
    // The shadow decides from the profile alone: the values the model typed are what it is judged
    // against, so offering them back as options would only measure that it can match strings.
    const memories = await getProfileMemories()
    const model = memories.length ? deps.chatModel() : null
    if (!model) return
    const profile = await profileLookup(model, memories)
    if (Object.keys(profile).length === 0) return
    const lookup: Lookup = { profile, request: {} }
    const { request, questions } = fillRequest({ goal, url: obs.snap.url, title: obs.snap.title, lookup, fields })
    const at = Date.now()
    const llm = { op: 'fill' }
    let record: ShadowRecord
    try {
      // dropIfBusy, like a step: a shadow never queues behind newer work.
      const result = await engine().decide(request, { dropIfBusy: true })
      if (result === null) return // superseded by a newer decision: nothing to compare
      const plan = planFill(questions, result.answers, lookup, resolver.threshold())
      record = fillRecordOf(n, at, llm, questions, result, lookup, plan, new Map(obs.fields.map((f) => [f.index, f.value])))
    } catch (err) {
      record = skippedOf(n, at, llm, err, 'fill')
    }
    await putShadow(record)
  }

  /** observeFill's shadow, for both realms: like shadow() above, `capture` runs synchronously. */
  function shadowFill(capture: () => { obs: Omit<FillObservation, 'selectOptions'>; options: Promise<Record<number, string[]>> }): void {
    const n = seq++
    try {
      if (!isDeciderOn(resolver.settingsMode()) || resolver.ready() === false) return
      const { obs, options } = capture()
      if (obs.fields.length === 0) return
      void observeAndRecord(n, deps.currentGoal(), obs, options).catch(() => {})
    } catch {
      /* additive only: a broken decider must never touch the fill */
    }
  }

  /** The panel's own select read, started now; never rejects. */
  function optionsNow(tabId: number, snap: FormSnap): Promise<Record<number, string[]>> {
    try {
      return readSelectOptions(tabId, selectIndicesOf(snap.elements)).catch(() => ({}))
    } catch {
      return Promise.resolve({})
    }
  }

  // -------------------------------------------------------------------------
  // Driver: one FastSteps step
  // -------------------------------------------------------------------------

  const steer = (): { steerPending?: true } => {
    try {
      return deps.steerPending?.() === true ? { steerPending: true } : {}
    } catch {
      return {}
    }
  }

  /**
   * The value for a `type` or `select` at the top: the single-field fill question (state.ts's
   * formFields + fillRequest) — for a text field over lookup keys, for a select over its own options
   * (the worker read them) with the lookup as the context — and the chosen text when it clears the
   * threshold. Never throws: no value is a hand-back ("needs value"), not a failure. `entry` is the
   * record's view of the answer used: a key NAME or an option's POSITION, never the text.
   *
   * VALUES FIRST, THE PROFILE LAZILY (Task 18). Structuring the profile is a chat-model call: on a
   * local model it measured 13–26 s (median 19 s) inside the first `type` of every FastSteps call,
   * although every one of those values came from `values` (results §14.6). So the question is
   * asked over the request's own values first — a text field over `request.*` + `leave_empty`; a
   * select only when one of its options names a request value (`optionNamesValue`), since a
   * request with nothing to say about this select would leave the decider guessing a default where
   * the profile might know (a country) — and a confident answer from the values returns without
   * touching the profile. Only when the values could not answer (leave_empty, under the threshold,
   * or no first pass) AND there are profile memories is the profile structured (profileLookup's
   * cached promise — usually the grant's pre-warm) and the question asked again over the full lookup.
   * Assist's mapForm is unchanged: a whole form wants the profile anyway.
   */
  async function fieldValue(
    step: NextStep,
    el: IndexedElement | undefined,
    op: 'type' | 'select',
    cancelled: () => boolean,
  ): Promise<{ ms: number; value?: { key: string; text: string; p: number }; entry?: NonNullable<ShadowRecord['fill']>[number] }> {
    let ms = 0
    let last: { value?: { key: string; text: string; p: number }; entry?: NonNullable<ShadowRecord['fill']>[number] } = {}
    try {
      const field = el ? formFields([el], step.selectOptions)[0] : undefined
      if (!field || field.kind !== (op === 'type' ? 'text' : 'select')) return { ms: 0 }
      // The user's overall request rides beside the sub-goal (`task`, state.ts's fillRequest): the
      // next-action question follows the session plan past a narrow sub-goal, and a value chosen
      // from the sub-goal alone picked quantity "1" for "add 2 of them" (results §15.5).
      const task = deps.currentGoal()
      const ask = async (lookup: Lookup): Promise<typeof last> => {
        const { request, questions } = fillRequest({ goal: step.goal, task, url: step.snap.url, title: step.snap.title, lookup, fields: [field] })
        const result = (await engine().decide(request)) as DecisionResult
        ms += result.ms
        const q = questions[0]
        const a = result.answers[q.name]
        if (!a) return {}
        const key = fillKey(q, a, Object.keys(lookup.request))
        const entry = { index: field.index, key, p: a.p, llmAgrees: null }
        const text = op === 'select' ? a.top : a.top === 'leave_empty' ? undefined : lookupValue(lookup, a.top)
        if (!(a.p >= resolver.threshold()) || text === undefined) return { entry }
        return { entry, value: { key: op === 'select' ? key : a.top, text, p: a.p } }
      }
      const valuesOnly: Lookup = { profile: {}, request: step.values }
      // 1. The request's own values.
      const first = op === 'type' ? Object.keys(step.values).length > 0 : optionNamesValue(field.options ?? [], step.values)
      if (first) {
        last = await ask(valuesOnly)
        if (last.value || cancelled()) return { ms, ...last }
      }
      // 2. The profile, only now — and the question again over everything.
      let lookup: Lookup
      try {
        lookup = await lookupFor(step.values)
      } catch {
        lookup = valuesOnly // the profile could not be read: the values are all there is
      }
      if (cancelled()) return { ms, ...last }
      if (Object.keys(lookup.profile).length === 0) {
        // Nothing to add. Asked already (or, for a text field, nothing to ask over); a select that
        // named no value is still asked over its options, as before there was a first pass.
        if (first || op === 'type') return { ms, ...last }
      }
      last = await ask(lookup)
      return { ms, ...last }
    } catch {
      return { ms, ...last }
    }
  }

  /** The next-action options without the excluded pairs: criteria and actions stay index-aligned. */
  function withoutExcluded(request: DecisionRequest, actions: OptionAction[], exclude: OpRef[]): { request: DecisionRequest; actions: OptionAction[] } {
    if (exclude.length === 0) return { request, actions }
    const q = request.questions.next as Extract<DecisionRequest['questions'][string], { type: 'choice' }>
    const names = Object.keys(q.criteria)
    const keep = actions.map((a) => !exclude.some((x) => x.op === a.op && x.index === ('index' in a ? a.index : undefined)))
    return {
      request: { ...request, questions: { next: { ...q, criteria: Object.fromEntries(names.filter((_, k) => keep[k]).map((n) => [n, q.criteria[n]])) } } },
      actions: actions.filter((_, k) => keep[k]),
    }
  }

  const optionOf = (a: OptionAction, p: number): DriverOption => ('index' in a ? { op: a.op, index: a.index, p } : { op: a.op, p })

  /**
   * One driver step, for both realms: nextActionRequest minus the excluded pairs → decide (queued,
   * NOT dropIfBusy — FastSteps is waiting — and capped at DRIVER_MAX_TOKENS) → for a `type` at the
   * top, its value → a `drive` record. `cancelled` is the caller giving up; checked after each
   * decision, so an answer nobody will act on is neither returned nor recorded.
   */
  async function decideNext(n: number, step: NextStep, cancelled: () => boolean): Promise<DriverDecideOutcome> {
    if (resolver.settingsMode() !== 'driver') return { error: 'the decision model is not in Driver mode' }
    if (!(await resolver.resolveReady())) return { error: 'the decision model is not ready' }
    if (cancelled()) return { error: CANCELLED }
    const elements = step.snap.elements.map(asIndexed)
    const built = nextActionRequest({
      goal: step.goal,
      plan: step.plan,
      url: step.snap.url,
      title: step.snap.title,
      previousActions: step.previousActions,
      pageText: step.pageText ?? undefined,
      elements,
    })
    const { request, actions } = withoutExcluded(built.request, built.actions, step.exclude)
    const at = Date.now()
    let result: DecisionResult
    try {
      result = (await engine().decide(request, { maxTokens: DRIVER_MAX_TOKENS })) as DecisionResult
    } catch (err) {
      if (cancelled()) return { error: CANCELLED }
      void putShadow(skippedOf(n, at, null, err, 'drive')).catch(() => {})
      const message = err instanceof Error ? err.message : String(err)
      if (message.startsWith('too-long')) return { error: `dense page (${tooLongTokens(message)} tokens)`, dense: true }
      return { error: decideFailure(err) }
    }
    if (cancelled()) return { error: CANCELLED }
    const a = result.answers.next
    if (!a || a.probs.length !== actions.length || a.options.length !== actions.length) return { error: 'the decision does not match the options it was asked' }
    lastBackend = result.backend
    const order = a.probs
      .map((_, k) => k)
      .sort((x, y) => a.probs[y] - a.probs[x])
      .slice(0, 3)
    const top3 = order.map((k) => optionOf(actions[k], a.probs[k]))
    const best = actions[order[0]]
    const typed =
      best.op === 'type' || best.op === 'select' ? await fieldValue(step, elements.find((e) => e.index === best.index), best.op, cancelled) : { ms: 0 }
    if (cancelled()) return { error: CANCELLED }
    const ms = result.ms + typed.ms
    try {
      const record: ShadowRecord = {
        ...base(n, at, null, 'drive'),
        tokens: result.tokens,
        ms,
        backend: result.backend,
        cold: result.cold,
        top3: top3.map((o) => ({ ...o })),
        agree: null,
        // The loop also acts in the tentative band (0.4 to the threshold) on a step that is not a
        // point of no return, but that classifier needs fields the panel is never sent (href, the
        // ancestor's name), so this counts only the band where it acts unconditionally.
        wouldAct: top3[0].p >= resolver.threshold(),
        ...(typed.entry ? { fill: [typed.entry] } : {}),
      }
      void putShadow(record).catch(() => {})
    } catch {
      /* the record is a log; the decision stands */
    }
    return { top3, tokens: result.tokens, ms, ...(typed.value ? { value: typed.value } : {}) }
  }

  /** decideNext, with the steer flag attached and every throw turned into `{ error }`. */
  function nextFor(n: number, step: NextStep, cancelled: () => boolean): Promise<DriverDecideOutcome> {
    return decideNext(n, step, cancelled).then(
      (r) => ({ ...r, ...steer() }),
      (err) => ({ error: `the decision model failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200), ...steer() }),
    )
  }

  function sessionGranted(): void {
    try {
      if (!isDeciderOn(resolver.settingsMode())) return
      const ready = resolver.resolveReady()
      void ready.then((r) => (r ? engine().warm() : undefined)).catch(() => {})
      // Assist and driver fill from the profile, whose structuring is one chat-model call (cached
      // per memory set). Made now, while the chat model reads the page, rather than inside the
      // first fill — where it measured ~16 s on a local model, against a driver step's 30 s budget.
      // (A driver step waits on it only for a field its call's own values could not fill.)
      if (assistsForms(resolver.settingsMode())) void ready.then((r) => (r ? lookupFor({}) : undefined)).catch(() => {})
    } catch {
      /* additive only: a broken decider must never touch the grant */
    }
  }

  return {
    mode: resolver.mode,
    resolveMode: () => resolver.resolveReady().then(() => resolver.mode(), (): DeciderMode => 'off'),
    settingsMode: resolver.settingsMode,
    threshold: resolver.threshold,
    sessionGranted,
    observeStep(i) {
      shadow(() => stepOf(i))
    },
    relay(msg) {
      try {
        const m = parseDeciderRelay(msg)
        if (!m || m.conversationId !== deps.conversationId) return
        if (m.type === 'decider.granted') sessionGranted()
        else if (m.type === 'decider.fill') shadowFill(() => ({ obs: m.fill, options: Promise.resolve(m.fill.selectOptions) }))
        else if (m.type === 'decider.mapForm.cancel' || m.type === 'decider.next.cancel') {
          const request = pending.get(m.requestId)
          if (request) request.cancelled = true
        } else shadow(() => m.step)
      } catch {
        /* additive only */
      }
    },

    next(i) {
      const n = seq++
      try {
        if (i.signal?.aborted) return Promise.resolve({ error: STOPPED })
        const aborted = () => i.signal?.aborted === true
        const snap = formSnapOf(i.snap)
        const previousActions = previousActionsOf(i.session, i.snap)
        const stepP = optionsNow(i.tabId, snap).then(
          (selectOptions): NextStep => ({
            tabId: i.tabId,
            goal: i.goal,
            plan: i.session.plan,
            values: { ...i.values },
            snap,
            pageText: i.pageText,
            selectOptions,
            previousActions,
            exclude: i.exclude,
          }),
        )
        // Stop ends the wait at once; decideNext, still running, sees the abort and drops its answer.
        return Promise.race([
          stepP.then((step) => nextFor(n, step, aborted)).then((r) => (aborted() ? { error: STOPPED } : r)),
          whenAborted(i.signal).then(() => ({ error: STOPPED })),
        ])
      } catch (err) {
        return Promise.resolve({ error: `the decision model failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) })
      }
    },

    observeFill(i) {
      shadowFill(() => {
        const snap = formSnapOf(i.snap)
        const fields = observedFields(i.fields, snap.elements)
        return {
          obs: { tabId: i.tabId, snap, plan: i.session.plan, fields },
          // Started now, before the fill types anything — and only when there is a field to judge.
          options: fields.length ? optionsNow(i.tabId, snap) : Promise.resolve({}),
        }
      })
    },

    mapForm(i) {
      const n = seq++
      try {
        if (i.signal?.aborted) return Promise.resolve({ error: STOPPED })
        const snap = formSnapOf(i.snap)
        const aborted = () => i.signal?.aborted === true
        // Stop ends the wait at once; planForm, still running, sees the abort and drops its plan.
        return Promise.race([
          planForm(n, { snap }, () => optionsNow(i.tabId, snap), { ...i.values }, aborted).then((r) => (aborted() ? { error: STOPPED } : r)),
          whenAborted(i.signal).then(() => ({ error: STOPPED })),
        ])
      } catch (err) {
        return Promise.resolve({ error: `the decision model failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) })
      }
    },

    answer(msg) {
      try {
        if ((msg as { type?: unknown } | null)?.type === 'decider.next') {
          const m = parseNextRequest(msg)
          if (!m || m.conversationId !== deps.conversationId) return undefined
          const n = seq++
          const request = { cancelled: false }
          pending.set(m.requestId, request)
          const { type: _type, conversationId: _conversationId, requestId, ...step } = m
          return nextFor(n, step, () => request.cancelled)
            .then((r): NextReply => (request.cancelled ? { requestId, error: CANCELLED } : { requestId, ...r }))
            .finally(() => {
              if (pending.get(requestId) === request) pending.delete(requestId)
            })
        }
        const m = parseMapFormRequest(msg)
        if (!m || m.conversationId !== deps.conversationId) return undefined
        const n = seq++
        const request = { cancelled: false }
        pending.set(m.requestId, request)
        // The worker read the options before it asked; reading them again here could only see
        // a page that has moved on.
        return planForm(n, { snap: m.snap }, () => Promise.resolve(m.selectOptions), m.values, () => request.cancelled)
          .then(
            (r): MapFormReply =>
              request.cancelled ? { requestId: m.requestId, error: CANCELLED } : 'error' in r ? { requestId: m.requestId, error: r.error } : { requestId: m.requestId, plan: r },
            (err): MapFormReply => ({ requestId: m.requestId, error: err instanceof Error ? err.message : String(err) }),
          )
          .finally(() => {
            if (pending.get(m.requestId) === request) pending.delete(m.requestId)
          })
      } catch {
        return undefined
      }
    },
  }
}

/** The service worker's script, as manifest.json's `background.service_worker` names it. */
const SERVICE_WORKER_SCRIPT = 'background.js'

/**
 * The `chrome.runtime.onMessage` listener runTurnChain (src/ui/Chat.tsx) registers for the life of
 * one chain, and removes in its outer `finally`. It hands a message to the chain's hooks only when
 * it comes from THIS extension's service worker — not another extension, not a content script, not
 * another of our own pages — and names this chain's conversation; the hooks then validate the rest.
 *
 * A step, grant or fill observation is fire-and-forget: the listener returns nothing, so it never
 * holds the sender's channel open. A request — assist's `decider.mapForm`, driver's `decider.next` —
 * is the exception: the listener returns `true` and answers through `sendResponse` once the plan or
 * decision (or its error) is ready. Another conversation's request is left alone, for that
 * conversation's own chain. Never throws.
 */
export function deciderRelayListener(
  decider: Pick<DeciderPanelHooks, 'relay' | 'answer'>,
  conversationId: string,
): (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse?: (reply: MapFormReply | NextReply) => void) => true | undefined {
  return (msg, sender, sendResponse) => {
    try {
      if (!sender || sender.id !== chrome.runtime.id || sender.tab) return undefined
      if (sender.url !== chrome.runtime.getURL(SERVICE_WORKER_SCRIPT)) return undefined
      if (typeof msg !== 'object' || msg === null || (msg as { conversationId?: unknown }).conversationId !== conversationId) return undefined
      const type = (msg as { type?: unknown }).type
      if (type === 'decider.mapForm' || type === 'decider.next') {
        const reply = decider.answer(msg)
        if (!reply) return undefined
        void reply.then((r) => {
          try {
            sendResponse?.(r)
          } catch {
            /* the worker gave up waiting: its timeout already answered the tool */
          }
        })
        return true
      }
      decider.relay(msg)
    } catch {
      /* additive only */
    }
    return undefined
  }
}
