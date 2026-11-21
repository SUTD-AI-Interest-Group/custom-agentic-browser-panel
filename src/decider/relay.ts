// The decider across realms. Under durable chat, page-control tools EXECUTE in the service worker
// (src/background/toolHost.ts builds its own createAgentTools; the panel's ToolSet only supplies
// schemas), while the decision engine is panel-resident — one model in GPU memory, shared with the
// self-test, and a dedicated Worker the service worker could not spawn anyway. So the worker side
// gets `forwardDeciderHooks`, which posts each step to the panel as a transient runtime message,
// and the panel's chain-scoped hooks (createDeciderHooks(...).relay, src/decider/hooks.ts) run it.
//
// This module is bundled into the service worker: it must never import the engine, its worker,
// OPFS storage (storage.ts — importModel/deleteModel/getDirectory), the shadow store, or the panel
// hooks. Its only runtime imports are config.ts (constants) and platform/viewportText.ts (one
// chrome.scripting injection); relay.test.ts walks the import closure to hold that line. Model
// readiness is therefore an injected probe here — the panel passes storage.ts's isModelReady.
//
// WHAT CROSSES THE CHANNEL is exactly what a decision needs and nothing more — `stepOf` below:
// url/title, the plan, the last six journal summaries (already redacted, pageControlJournal.ts),
// the spec's action/index/direction (never its text/value/url/label), and per element only the
// fields the request builder reads, with a sensitive field's value masked — plus the viewport text,
// read by the worker before the action runs (see forwardDeciderHooks). The panel validates every
// message with `parseDeciderRelay` and rebuilds it field by field, so nothing else rides along.
// Nothing here is persisted: the ShadowRecord the panel writes is still numbers and enums.

import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import { readViewportText } from '../platform/viewportText'
import type { ControlAction, ControlSession, ControlSpec } from '../tools/pageControl'
import { DEFAULT_ACT_THRESHOLD, PAGE_TEXT_CAP, PREVIOUS_ACTIONS_WINDOW, type DeciderMode, type DeciderSettings } from './config'
import type { DeciderHooks } from './hooks'

// ---------------------------------------------------------------------------
// Mode resolution, shared by both realms
// ---------------------------------------------------------------------------

export const isDeciderOn = (m: DeciderMode | undefined): m is 'shadow' | 'assist' => m === 'shadow' || m === 'assist'

/** The settings' mode alone, 'off' when absent or unreadable. Never throws. */
export function settingsModeOf(settings: () => DeciderSettings | undefined): DeciderMode {
  try {
    return settings()?.mode ?? 'off'
  } catch {
    return 'off'
  }
}

/**
 * `mode()` = the settings' mode, but 'off' until the imported model is proven ready. Readiness is
 * probed once per resolver (the hooks are built once per chain) and lazily: the first call that
 * needs it starts the probe and still answers 'off' — a caller that must not miss the first step
 * awaits `resolveReady()` instead. Nothing here throws.
 */
export function createModeResolver(settings: () => DeciderSettings | undefined, modelReady: () => Promise<boolean>) {
  let ready: boolean | undefined
  let readyP: Promise<boolean> | null = null
  const resolveReady = (): Promise<boolean> => {
    if (!readyP) {
      readyP = Promise.resolve()
        .then(() => modelReady())
        .then(
          (r) => r === true,
          () => false,
        )
        .then((r) => (ready = r))
    }
    return readyP
  }
  const settingsMode = (): DeciderMode => settingsModeOf(settings)
  return {
    settingsMode,
    resolveReady,
    /** The cached probe result: undefined until it has settled. */
    ready: () => ready,
    mode(): DeciderMode {
      const m = settingsMode()
      if (!isDeciderOn(m)) return 'off'
      if (ready === undefined) {
        void resolveReady()
        return 'off'
      }
      return ready ? m : 'off'
    },
    threshold(): number {
      try {
        return settings()?.actThreshold ?? DEFAULT_ACT_THRESHOLD
      } catch {
        return DEFAULT_ACT_THRESHOLD
      }
    },
  }
}

// ---------------------------------------------------------------------------
// The step, as a decision needs it
// ---------------------------------------------------------------------------

/** The element fields the request builder (state.ts, via serializeRegistry) actually reads. */
export type DecisionElement = Pick<IndexedElement, 'index' | 'tag' | 'role' | 'name' | 'type' | 'value' | 'checked' | 'sensitive'>

export interface DecisionStep {
  tabId: number
  url: string
  title: string
  plan: string
  previousActions: string[]
  elements: DecisionElement[]
  spec: { action: ControlAction; index?: number; direction?: ControlSpec['direction'] }
  /**
   * The viewport text, read where the step was taken, before its action ran. Absent on the panel's
   * own path (the panel reads it); always present on a relayed step — `null` when that read failed.
   */
  pageText?: string | null
}

/** A step as it crosses the channel: the worker's pre-action page text always rides along. */
export type RelayedStep = DecisionStep & { pageText: string | null }

/**
 * What a sensitive field's value becomes. Whether a password box is filled matters to "what next";
 * what is in it never does — so the decider is told it is filled, and the raw value never crosses
 * the runtime channel (or reaches the model) at all.
 */
export const SENSITIVE_VALUE_MASK = '••••'

function decisionElement(e: IndexedElement): DecisionElement {
  const out: DecisionElement = { index: e.index, tag: e.tag, name: e.name, sensitive: e.sensitive === true }
  if (e.role !== undefined) out.role = e.role
  if (e.type !== undefined) out.type = e.type
  if (e.checked !== undefined) out.checked = e.checked
  if (e.value) out.value = e.sensitive ? SENSITIVE_VALUE_MASK : e.value
  return out
}

/**
 * Capture one ControlPage step NOW, synchronously: the action it describes is about to run, and
 * its own journal entry lands the moment runControlStep finishes.
 */
export function stepOf(i: { tabId: number; snap: PageSnapshot; spec: ControlSpec; session: ControlSession }): DecisionStep {
  const spec: DecisionStep['spec'] = { action: i.spec.action }
  if (i.spec.index !== undefined) spec.index = i.spec.index
  if (i.spec.direction !== undefined) spec.direction = i.spec.direction
  return {
    tabId: i.tabId,
    url: i.snap.url,
    title: i.snap.title,
    plan: i.session.plan,
    previousActions: (i.session.journal ?? []).slice(-PREVIOUS_ACTIONS_WINDOW).map((e) => e.summary),
    elements: i.snap.elements.map(decisionElement),
    spec,
  }
}

// ---------------------------------------------------------------------------
// The message, and its validator (the panel trusts nothing it did not rebuild)
// ---------------------------------------------------------------------------

export type DeciderRelayMsg =
  | { type: 'decider.granted'; conversationId: string }
  | { type: 'decider.step'; conversationId: string; step: RelayedStep }

const ACTIONS: ReadonlySet<string> = new Set<ControlAction>(['click', 'type', 'select', 'scroll', 'highlight', 'navigate', 'press', 'wait'])
const DIRECTIONS: ReadonlySet<string> = new Set(['up', 'down', 'toElement'])
/** domIndex caps a snapshot at 200; anything far beyond that is not a snapshot. */
const MAX_RELAYED_ELEMENTS = 1000
const MAX_STRING = 20_000

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_STRING
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const optStr = (v: unknown) => v === undefined || isStr(v)

function parseElement(raw: unknown): DecisionElement | null {
  if (!isObj(raw) || !isIndex(raw.index) || !isStr(raw.tag) || !isStr(raw.name) || typeof raw.sensitive !== 'boolean') return null
  if (!optStr(raw.role) || !optStr(raw.type) || !optStr(raw.value)) return null
  if (raw.checked !== undefined && typeof raw.checked !== 'boolean') return null
  const out: DecisionElement = { index: raw.index, tag: raw.tag, name: raw.name, sensitive: raw.sensitive }
  if (raw.role !== undefined) out.role = raw.role as string
  if (raw.type !== undefined) out.type = raw.type as string
  if (raw.value !== undefined) out.value = raw.sensitive ? SENSITIVE_VALUE_MASK : (raw.value as string)
  if (raw.checked !== undefined) out.checked = raw.checked as boolean
  return out
}

function parseStep(raw: unknown): RelayedStep | null {
  if (!isObj(raw) || !isIndex(raw.tabId) || !isStr(raw.url) || !isStr(raw.title) || !isStr(raw.plan)) return null
  // Required: a panel-side re-read would land after the worker had moved on to the action.
  if (raw.pageText !== null && !isStr(raw.pageText)) return null
  if (!Array.isArray(raw.previousActions) || !raw.previousActions.every(isStr)) return null
  if (!Array.isArray(raw.elements) || raw.elements.length > MAX_RELAYED_ELEMENTS) return null
  const elements: DecisionElement[] = []
  for (const e of raw.elements) {
    const parsed = parseElement(e)
    if (!parsed) return null
    elements.push(parsed)
  }
  const s = raw.spec
  if (!isObj(s) || typeof s.action !== 'string' || !ACTIONS.has(s.action)) return null
  if (s.index !== undefined && !isIndex(s.index)) return null
  if (s.direction !== undefined && !(typeof s.direction === 'string' && DIRECTIONS.has(s.direction))) return null
  const spec: DecisionStep['spec'] = { action: s.action as ControlAction }
  if (s.index !== undefined) spec.index = s.index as number
  if (s.direction !== undefined) spec.direction = s.direction as DecisionStep['spec']['direction']
  return {
    tabId: raw.tabId,
    url: raw.url,
    title: raw.title,
    plan: raw.plan,
    previousActions: (raw.previousActions as string[]).slice(-PREVIOUS_ACTIONS_WINDOW),
    elements,
    spec,
    pageText: raw.pageText as string | null,
  }
}

/** A well-formed decider relay message, rebuilt field by field — or null. Pure. */
export function parseDeciderRelay(raw: unknown): DeciderRelayMsg | null {
  if (!isObj(raw) || !isStr(raw.conversationId) || raw.conversationId === '') return null
  if (raw.type === 'decider.granted') return { type: 'decider.granted', conversationId: raw.conversationId }
  if (raw.type !== 'decider.step') return null
  const step = parseStep(raw.step)
  return step ? { type: 'decider.step', conversationId: raw.conversationId, step } : null
}

// ---------------------------------------------------------------------------
// The service-worker side
// ---------------------------------------------------------------------------

const defaultSend = (msg: DeciderRelayMsg): unknown => chrome.runtime.sendMessage(msg)

/** Start the viewport read NOW (its injection is issued before this returns); never rejects. */
function pageTextNow(tabId: number): Promise<string | null> {
  try {
    return readViewportText(tabId, PAGE_TEXT_CAP).then(
      (t) => (typeof t === 'string' ? t : null),
      () => null,
    )
  } catch {
    return Promise.resolve(null)
  }
}

/**
 * DeciderHooks for the realm that executes the tools (toolHost.ts). Every hook is synchronous and
 * fire-and-forget: nothing is ever awaited on the ControlPage path, and every failure — no panel
 * open ("Receiving end does not exist"), a closed channel, a throw — is swallowed. Nothing is read
 * or sent unless the user turned the decider on, so page structure never rides the runtime
 * channel for anyone who has not opted in.
 *
 * The viewport text is read HERE, not in the panel: observeStep runs before the action, and the
 * read's injection is issued synchronously, so it is queued ahead of the action's own injections —
 * whereas a panel-side read would only start once the message arrived, with the worker already
 * clicking. The step is posted when that read settles (`pageText: null` if it failed).
 *
 * `mode()`: with an injected `modelReady` probe, the settings' mode once the model is proven ready
 * (createModeResolver); without one, the settings' mode alone — the panel owns the engine and
 * checks readiness before every decision. The default build injects no probe: storage.ts carries
 * OPFS code this service-worker bundle must not pull in.
 */
export function forwardDeciderHooks(deps: {
  conversationId: string
  settings: () => DeciderSettings | undefined
  send?: (msg: DeciderRelayMsg) => unknown
  modelReady?: () => Promise<boolean>
}): DeciderHooks {
  const resolver = deps.modelReady ? createModeResolver(deps.settings, deps.modelReady) : null
  const on = () => isDeciderOn(settingsModeOf(deps.settings))
  const post = (msg: DeciderRelayMsg) => {
    try {
      void Promise.resolve((deps.send ?? defaultSend)(msg)).catch(() => {})
    } catch {
      /* no panel, no channel: shadowing is best-effort */
    }
  }
  return {
    mode: () => (resolver ? resolver.mode() : settingsModeOf(deps.settings)),
    threshold: () => {
      try {
        return deps.settings()?.actThreshold ?? DEFAULT_ACT_THRESHOLD
      } catch {
        return DEFAULT_ACT_THRESHOLD
      }
    },
    sessionGranted() {
      if (on()) post({ type: 'decider.granted', conversationId: deps.conversationId })
    },
    observeStep(i) {
      try {
        if (!on()) return
        const step = stepOf(i)
        void pageTextNow(step.tabId).then((pageText) =>
          post({ type: 'decider.step', conversationId: deps.conversationId, step: { ...step, pageText } }),
        )
      } catch {
        /* additive only */
      }
    },
    // TODO(Task 11): forward to the panel as well.
    observeFill() {},
    // TODO(Task 11): a request/response round trip to the panel, with a timeout on this side.
    mapForm() {
      return Promise.resolve({ error: 'assist mode is not implemented yet' })
    },
  }
}
