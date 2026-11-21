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
// Built ONCE per continuation chain, so `seq` numbers every step this chain's hooks were handed —
// recorded, dropped or off alike — and model readiness is probed once per chain.
//
// NO USER DATA IN THE RECORD (shadowStore.ts's rule, after traces.ts). The request handed to the
// engine carries the goal, page text and element names, and never leaves the device: the engine
// is a local worker. The stored ShadowRecord carries op names, indices, numbers and enums only —
// `llm` is built from the spec's action/index alone, never its text/value/url/label, and options
// are mapped back through `actions` (indices), never through their element descriptions.
// hooks.test.ts drives a password through both paths (local and forwarded) to hold that line.

import type { LanguageModel, ModelMessage } from 'ai'
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import { readViewportText } from '../platform/viewportText'
import type { ControlSession, ControlSpec } from '../tools/pageControl'
import { MODEL_ID, PAGE_TEXT_CAP, type DeciderMode, type DeciderSettings } from './config'
import { getDeciderEngine, type DeciderEngine } from './engine'
import type { FillPlan } from './fillPlan'
import type { DecisionResult } from './protocol'
import { createModeResolver, isDeciderOn, parseDeciderRelay, stepOf, type DecisionStep } from './relay'
import { putShadow, type ShadowRecord } from './shadowStore'
import { nextActionRequest, type OptionAction } from './state'

export interface DeciderHooks {
  /** 'off' unless the settings say shadow/assist AND the imported model is ready. */
  mode(): DeciderMode
  threshold(): number
  /** A page-control session was granted: warm the engine (never awaited; errors swallowed). */
  sessionGranted(): void
  /** Fire-and-forget: shadow one ControlPage step. Never throws, never needs awaiting. */
  observeStep(i: { tabId: number; snap: PageSnapshot; spec: ControlSpec; session: ControlSession }): void
  /** Task 11: shadow an AutofillForm call that brought its own `fields`. */
  observeFill(i: { tabId: number; snap: PageSnapshot; session: ControlSession; fields: { index: number; value: string }[] }): void
  /** Task 11: map a form's fields from profile + request values (assist mode). */
  mapForm(i: { tabId: number; snap: PageSnapshot; session: ControlSession; values: Record<string, string> }): Promise<FillPlan | { error: string }>
}

/** The panel's hooks: DeciderHooks plus the entry point for steps forwarded from the worker. */
export interface DeciderPanelHooks extends DeciderHooks {
  /**
   * Handle one runtime message. Anything that is not a well-formed decider relay message for THIS
   * conversation is ignored. Synchronous and fire-and-forget, like observeStep. Never throws.
   */
  relay(msg: unknown): void
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
// The hooks
// ---------------------------------------------------------------------------

export function createDeciderHooks(deps: DeciderHookDeps): DeciderPanelHooks {
  const engine = (): DeciderEngineLike => deps.engine ?? getDeciderEngine()
  const resolver = createModeResolver(deps.settings, deps.modelReady)
  let seq = 0
  // A skipped record still needs a backend; the last one this chain saw is the honest guess
  // (summarize() leaves skipped records out of every latency figure regardless).
  let lastBackend: ShadowRecord['backend'] = 'wasm'

  const base = (n: number, at: number, llm: Llm) => ({
    id: crypto.randomUUID(),
    conversationId: deps.conversationId,
    seq: n,
    at,
    kind: 'next' as const,
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

  function skippedOf(n: number, at: number, llm: Llm, err: unknown): ShadowRecord {
    const message = err instanceof Error ? err.message : String(err)
    const tooLong = message.startsWith('too-long')
    return {
      ...base(n, at, llm),
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
    // With readiness already known, start the viewport read before the first await: the action
    // this step shadows is about to run, and the text should describe the page it was chosen on.
    const textP = resolver.ready() === true ? readViewportText(step.tabId, PAGE_TEXT_CAP) : null
    if (!textP && !(await resolver.resolveReady())) return
    const llm: Llm = step.spec.index === undefined ? { op: step.spec.action } : { op: step.spec.action, index: step.spec.index }
    let record: ShadowRecord
    try {
      const pageText = await (textP ?? readViewportText(step.tabId, PAGE_TEXT_CAP))
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
        else shadow(() => m.step)
      } catch {
        /* additive only */
      }
    },

    // TODO(Task 11): shadow AutofillForm's own field mapping.
    observeFill() {},

    // TODO(Task 11): the assist path (profileLookup → fillRequest → decide → planFill).
    mapForm() {
      return Promise.resolve({ error: 'assist mode is not implemented yet' })
    },
  }
}
