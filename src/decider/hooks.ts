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
import { MODEL_ID, PAGE_TEXT_CAP, type DeciderMode, type DeciderSettings } from './config'
import { getDeciderEngine, type DeciderEngine } from './engine'
import { planFill, type FillPlan } from './fillPlan'
import { profileLookup } from './profileLookup'
import type { DecisionResult } from './protocol'
import type { Answer } from './readout'
import {
  createModeResolver,
  formSnapOf,
  isDeciderOn,
  observedFields,
  parseDeciderRelay,
  parseMapFormRequest,
  selectIndicesOf,
  stepOf,
  type DecisionStep,
  type FillObservation,
  type FormSnap,
  type MapFormReply,
} from './relay'
import { putShadow, type ShadowRecord } from './shadowStore'
import { fillRequest, formFields, nextActionRequest, type FillQuestion, type Lookup, type OptionAction } from './state'
import { isModelReady } from './storage'

export interface DeciderHooks {
  /** 'off' unless the settings say shadow/assist AND the imported model is ready. */
  mode(): DeciderMode
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
   * by AutofillForm; resolves a plan or `{ error }` (a short reason), never rejects.
   */
  mapForm(i: { tabId: number; snap: PageSnapshot; session: ControlSession; values: Record<string, string> }): Promise<FillPlan | { error: string }>
}

/** The panel's hooks: DeciderHooks plus the entry points for messages from the worker. */
export interface DeciderPanelHooks extends DeciderHooks {
  /**
   * Handle one runtime message. Anything that is not a well-formed decider relay message for THIS
   * conversation is ignored. Synchronous and fire-and-forget, like observeStep. Never throws.
   */
  relay(msg: unknown): void
  /**
   * Answer the worker's assist request (`decider.mapForm`) for THIS conversation: the reply to hand
   * to sendResponse. `undefined` for anything else — another conversation's request is left for
   * that conversation's own chain to answer. Never throws; the promise never rejects.
   */
  answer(msg: unknown): Promise<MapFormReply> | undefined
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
 * The record's key for one field's answer: a lookup key NAME (`profile.email`, `request.message`,
 * `leave_empty`), a select option's POSITION (`option.0` — a label can be user data: a saved-address
 * dropdown lists the address), or `tick`/`leave`. Never a value.
 */
function fillKey(q: FillQuestion, a: Answer): string {
  if (q.field.kind === 'select') return `option.${q.options.indexOf(a.top)}`
  if (q.field.kind === 'checkbox') return a.top === 'true' ? 'tick' : 'leave'
  return a.top
}

const fold = (s: string) => s.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()

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
    for (const q of questions) {
      const a = result.answers[q.name]
      if (!a) continue
      fill.push({ index: q.field.index, key: fillKey(q, a), p: a.p, llmAgrees: typed ? judgeFill(q, a, lookup, typed.get(q.field.index)) : null })
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
   */
  async function planForm(
    n: number,
    form: { snap: FormSnap },
    options: () => Promise<Record<number, string[]>>,
    values: Record<string, string>,
  ): Promise<FillPlan | { error: string }> {
    try {
      if (resolver.settingsMode() !== 'assist') return { error: 'the decision model is not in Assist mode' }
      if (!(await resolver.resolveReady())) return { error: 'the decision model is not ready' }
      const fields = formFields(form.snap.elements.map(asIndexed), await options())
      if (fields.length === 0) return { error: 'no fillable fields on this page' }
      const lookup = await lookupFor(values)
      if (Object.keys(lookup.profile).length === 0 && Object.keys(lookup.request).length === 0) return { error: NOTHING_TO_FILL }
      const { request, questions } = fillRequest({ goal: deps.currentGoal(), url: form.snap.url, title: form.snap.title, lookup, fields })
      const at = Date.now()
      let result: DecisionResult | null
      try {
        result = await engine().decide(request)
        if (!result) throw new Error('the decision was dropped')
      } catch (err) {
        void putShadow(skippedOf(n, at, null, err, 'fill')).catch(() => {})
        return { error: decideFailure(err) }
      }
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
      const result = await engine().decide(request)
      if (result === null) return
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

  function sessionGranted(): void {
    try {
      if (!isDeciderOn(resolver.settingsMode())) return
      void resolver
        .resolveReady()
        .then((r) => (r ? engine().warm() : undefined))
        .catch(() => {})
    } catch {
      /* additive only: a broken decider must never touch the grant */
    }
  }

  return {
    mode: resolver.mode,
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
        else shadow(() => m.step)
      } catch {
        /* additive only */
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
        const snap = formSnapOf(i.snap)
        return planForm(n, { snap }, () => optionsNow(i.tabId, snap), { ...i.values })
      } catch (err) {
        return Promise.resolve({ error: `the decision model failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) })
      }
    },

    answer(msg) {
      try {
        const m = parseMapFormRequest(msg)
        if (!m || m.conversationId !== deps.conversationId) return undefined
        const n = seq++
        // The worker read the options before it asked; reading them again here could only see
        // a page that has moved on.
        return planForm(n, { snap: m.snap }, () => Promise.resolve(m.selectOptions), m.values).then(
          (r): MapFormReply => ('error' in r ? { requestId: m.requestId, error: r.error } : { requestId: m.requestId, plan: r }),
          (err): MapFormReply => ({ requestId: m.requestId, error: err instanceof Error ? err.message : String(err) }),
        )
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
 * holds the sender's channel open. An assist request (`decider.mapForm`) is the one exception: the
 * listener returns `true` and answers through `sendResponse` once the plan (or its error) is ready.
 * Another conversation's request is left alone, for that conversation's own chain. Never throws.
 */
export function deciderRelayListener(
  decider: Pick<DeciderPanelHooks, 'relay' | 'answer'>,
  conversationId: string,
): (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse?: (reply: MapFormReply) => void) => true | undefined {
  return (msg, sender, sendResponse) => {
    try {
      if (!sender || sender.id !== chrome.runtime.id || sender.tab) return undefined
      if (sender.url !== chrome.runtime.getURL(SERVICE_WORKER_SCRIPT)) return undefined
      if (typeof msg !== 'object' || msg === null || (msg as { conversationId?: unknown }).conversationId !== conversationId) return undefined
      if ((msg as { type?: unknown }).type === 'decider.mapForm') {
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
