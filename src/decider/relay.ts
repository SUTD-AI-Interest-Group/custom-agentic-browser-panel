// The decider across realms. Under durable chat, page-control tools EXECUTE in the service worker
// (src/background/toolHost.ts builds its own createAgentTools; the panel's ToolSet only supplies
// schemas), while the decision engine is panel-resident — one model in GPU memory, shared with the
// self-test, and a dedicated Worker the service worker could not spawn anyway. So the worker side
// gets `forwardDeciderHooks`, which posts each step to the panel as a transient runtime message,
// and the panel's chain-scoped hooks (createDeciderHooks(...).relay, src/decider/hooks.ts) run it.
//
// This module is bundled into the service worker: it must never import the engine, its worker,
// OPFS storage (storage.ts — importModel/deleteModel/getDirectory), the shadow store, or the panel
// hooks. Its only runtime imports are config.ts (constants), platform/viewportText.ts and
// platform/domIndex.ts (chrome.scripting injections); relay.test.ts walks the import closure to
// hold that line. Model readiness is therefore an injected probe here — the panel passes
// storage.ts's isModelReady.
//
// FORM FILLING (AutofillForm) crosses the same channel two ways. Shadowing a call that brought
// its own fields is a post like a step (`decider.fill`). Assist — the decider maps the form — is a
// REQUEST: the worker sends `decider.mapForm` and awaits the panel's `sendResponse` (bounded by
// MAP_FORM_TIMEOUT_MS), so no pending-request state ever lives in an evictable worker. The plan
// that comes back carries profile values to the worker: transient, in memory, and validated field
// by field against the worker's own snapshot before AutofillForm's guarded loop types a thing.
//
// WHAT CROSSES THE CHANNEL is exactly what a decision needs and nothing more — `stepOf` below:
// url/title, the plan, the last ten journal entries as `deciderActionLine`s (built from the
// journal's already-redacted values, pageControlJournal.ts),
// the spec's action/index/direction (never its text/value/url/label), and per element only the
// fields the request builder reads, with a sensitive field's value masked — plus the viewport text,
// read by the worker before the action runs (see forwardDeciderHooks). The panel validates every
// message with `parseDeciderRelay` and rebuilds it field by field, so nothing else rides along.
// Nothing here is persisted: the ShadowRecord the panel writes is still numbers and enums.

import { readSelectOptions, type IndexedElement, type PageSnapshot } from '../platform/domIndex'
import { readViewportText } from '../platform/viewportText'
import type { ControlAction, ControlSession, ControlSpec } from '../tools/pageControl'
import type { ControlJournalEntry } from '../tools/pageControlJournal'
import { DEFAULT_ACT_THRESHOLD, PAGE_TEXT_CAP, PREVIOUS_ACTIONS_WINDOW, type DeciderMode, type DeciderSettings } from './config'
import type { FillPlan } from './fillPlan'
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

const VALUE_CAP = 80

/**
 * One previous action as the decider reads it. The journal's summary ("typed into “Full name”")
 * carries no value, and without one the decider cannot tell a field is done: the option
 * `type into [3] … = "Ada Lovelace"` then matches the goal best at every step (agreement 1/6 →
 * 6/6 with the value in, diag 2026-11-22). The value is the journal's own `redactedValue` —
 * already redacted there, and nothing new is persisted. A checkbox click says what it left
 * behind (`checkedNow`), since "clicked" alone does not say ticked or unticked.
 */
export function deciderActionLine(e: ControlJournalEntry, checkedNow?: boolean): string {
  const v = e.redactedValue
  const target = e.label ? `“${e.label}”` : e.index !== undefined ? `element ${e.index}` : 'the page'
  if (e.action === 'click' && checkedNow !== undefined) return `${checkedNow ? 'ticked' : 'unticked'} ${target}`
  if (v === undefined || (e.action !== 'type' && e.action !== 'select')) return e.summary
  const shown = v.length > VALUE_CAP ? v.slice(0, VALUE_CAP - 1) + '…' : v
  return e.action === 'type' ? `typed "${shown}" into ${target}` : `chose "${shown}" in ${target}`
}

/**
 * A checkbox/radio's state NOW, for a journal entry that clicked it — only when the entry ran on
 * this same page (url) and the element at its index is still a checkbox or radio; otherwise the
 * current element says nothing about what that click did.
 */
function checkedNowFor(e: ControlJournalEntry, snap: PageSnapshot): boolean | undefined {
  if (e.action !== 'click' || e.index === undefined || e.url !== snap.url) return undefined
  const el = snap.elements.find((x) => x.index === e.index)
  if (!el || el.tag !== 'input' || (el.type !== 'checkbox' && el.type !== 'radio')) return undefined
  return el.checked
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
    previousActions: (i.session.journal ?? []).slice(-PREVIOUS_ACTIONS_WINDOW).map((e) => deciderActionLine(e, checkedNowFor(e, i.snap))),
    elements: i.snap.elements.map(decisionElement),
    spec,
  }
}

// ---------------------------------------------------------------------------
// The form, as a fill decision needs it
// ---------------------------------------------------------------------------

/** A snapshot reduced to what a fill decision reads (state.ts's formFields/fillRequest). */
export interface FormSnap {
  url: string
  title: string
  elements: DecisionElement[]
}

export function formSnapOf(snap: PageSnapshot): FormSnap {
  return { url: snap.url, title: snap.title, elements: snap.elements.map(decisionElement) }
}

/** The selects whose options a fill decision needs: formFields never asks about a sensitive one. */
export const selectIndicesOf = (elements: Pick<IndexedElement, 'index' | 'tag' | 'sensitive'>[]): number[] =>
  elements.filter((e) => e.tag === 'select' && !e.sensitive).map((e) => e.index)

/** A field the chat model filled itself, as the shadow may compare it: never a sensitive one. */
export interface ObservedField {
  index: number
  value: string
}

/** One AutofillForm call that brought its own fields, as its shadow needs it. */
export interface FillObservation {
  tabId: number
  snap: FormSnap
  plan: string
  /** Read where the call ran, before it typed anything. */
  selectOptions: Record<number, string[]>
  fields: ObservedField[]
}

/**
 * The fields a shadow may see: not one the model flagged sensitive, not one on a sensitive
 * element. formFields never asks about either, so dropping them loses nothing — and keeps a typed
 * password off the runtime channel entirely.
 */
export function observedFields(fields: { index: number; value: string; sensitive?: boolean }[], elements: Pick<IndexedElement, 'index' | 'sensitive'>[]): ObservedField[] {
  const sensitive = new Set(elements.filter((e) => e.sensitive).map((e) => e.index))
  return fields.filter((f) => !f.sensitive && !sensitive.has(f.index)).map((f) => ({ index: f.index, value: f.value }))
}

/** The worker's assist request: map this form from the profile plus the request's own values. */
export interface MapFormRequest {
  type: 'decider.mapForm'
  conversationId: string
  requestId: string
  tabId: number
  snap: FormSnap
  plan: string
  selectOptions: Record<number, string[]>
  values: Record<string, string>
}

/** The panel's answer, through sendResponse. */
export type MapFormReply = { requestId: string; plan: FillPlan } | { requestId: string; error: string }

/**
 * How long the worker waits for a plan. The decision itself is a second or two, but on first use
 * the panel must also structure the profile memories with one chat-model call — on a local model
 * that has to load first, tens of seconds.
 */
export const MAP_FORM_TIMEOUT_MS = 90_000

// ---------------------------------------------------------------------------
// The message, and its validator (the panel trusts nothing it did not rebuild)
// ---------------------------------------------------------------------------

export type DeciderRelayMsg =
  | { type: 'decider.granted'; conversationId: string }
  | { type: 'decider.step'; conversationId: string; step: RelayedStep }
  | { type: 'decider.fill'; conversationId: string; fill: FillObservation }
  /** The worker stopped waiting for this request (timeout, or the call was aborted). */
  | { type: 'decider.mapForm.cancel'; conversationId: string; requestId: string }

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
  if (raw.type === 'decider.fill') {
    const fill = parseFillObservation(raw.fill)
    return fill ? { type: 'decider.fill', conversationId: raw.conversationId, fill } : null
  }
  if (raw.type === 'decider.mapForm.cancel') {
    if (!isStr(raw.requestId) || raw.requestId === '') return null
    return { type: 'decider.mapForm.cancel', conversationId: raw.conversationId, requestId: raw.requestId }
  }
  if (raw.type !== 'decider.step') return null
  const step = parseStep(raw.step)
  return step ? { type: 'decider.step', conversationId: raw.conversationId, step } : null
}

/** A select never offers more than the decider can answer (CODE_ROWS_WIDTH, readout.ts). */
const MAX_OPTIONS = 255
const MAX_VALUES = 50
const MAX_KEY = 64

function parseFormSnap(raw: unknown): FormSnap | null {
  if (!isObj(raw) || !isStr(raw.url) || !isStr(raw.title)) return null
  if (!Array.isArray(raw.elements) || raw.elements.length > MAX_RELAYED_ELEMENTS) return null
  const elements: DecisionElement[] = []
  for (const e of raw.elements) {
    const parsed = parseElement(e)
    if (!parsed) return null
    elements.push(parsed)
  }
  return { url: raw.url, title: raw.title, elements }
}

function parseSelectOptions(raw: unknown): Record<number, string[]> | null {
  if (!isObj(raw)) return null
  const out: Record<number, string[]> = {}
  for (const [k, v] of Object.entries(raw)) {
    const index = Number(k)
    if (!/^\d+$/.test(k) || !isIndex(index)) return null
    if (!Array.isArray(v) || v.length > MAX_OPTIONS || !v.every(isStr)) return null
    out[index] = [...(v as string[])]
  }
  return out
}

function parseValues(raw: unknown): Record<string, string> | null {
  if (!isObj(raw)) return null
  const entries = Object.entries(raw)
  if (entries.length > MAX_VALUES) return null
  const out: Record<string, string> = {}
  for (const [k, v] of entries) {
    if (k === '' || k.length > MAX_KEY || !isStr(v)) return null
    out[k] = v
  }
  return out
}

function parseFillObservation(raw: unknown): FillObservation | null {
  if (!isObj(raw) || !isIndex(raw.tabId) || !isStr(raw.plan)) return null
  const snap = parseFormSnap(raw.snap)
  const selectOptions = parseSelectOptions(raw.selectOptions)
  if (!snap || !selectOptions) return null
  if (!Array.isArray(raw.fields) || raw.fields.length > MAX_RELAYED_ELEMENTS) return null
  const fields: ObservedField[] = []
  for (const f of raw.fields) {
    if (!isObj(f) || !isIndex(f.index) || !isStr(f.value)) return null
    fields.push({ index: f.index, value: f.value })
  }
  return { tabId: raw.tabId, snap, plan: raw.plan, selectOptions, fields }
}

/** The worker's assist request, rebuilt field by field — or null. Pure. */
export function parseMapFormRequest(raw: unknown): MapFormRequest | null {
  if (!isObj(raw) || raw.type !== 'decider.mapForm') return null
  if (!isStr(raw.conversationId) || raw.conversationId === '' || !isStr(raw.requestId) || raw.requestId === '') return null
  if (!isIndex(raw.tabId) || !isStr(raw.plan)) return null
  const snap = parseFormSnap(raw.snap)
  const selectOptions = parseSelectOptions(raw.selectOptions)
  const values = parseValues(raw.values)
  if (!snap || !selectOptions || !values) return null
  return { type: 'decider.mapForm', conversationId: raw.conversationId, requestId: raw.requestId, tabId: raw.tabId, snap, plan: raw.plan, selectOptions, values }
}

const FILL_KINDS: ReadonlySet<string> = new Set(['text', 'select', 'checkbox'])
const LEFT_REASONS: ReadonlySet<string> = new Set(['low-confidence', 'leave-empty', 'already-set'])
const isProb = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

/**
 * The panel's plan, rebuilt field by field — or null. Every index must be on the page the worker
 * snapshotted, and no field may be filled twice; AutofillForm's loop then re-checks each element
 * against the live page before touching it.
 */
export function parseFillPlan(raw: unknown, onPage: ReadonlySet<number>): FillPlan | null {
  if (!isObj(raw) || !Array.isArray(raw.fills) || !Array.isArray(raw.left)) return null
  if (raw.fills.length > MAX_RELAYED_ELEMENTS || raw.left.length > MAX_RELAYED_ELEMENTS) return null
  const seen = new Set<number>()
  const fills: FillPlan['fills'] = []
  for (const f of raw.fills) {
    if (!isObj(f) || !isIndex(f.index) || !onPage.has(f.index) || seen.has(f.index)) return null
    if (typeof f.kind !== 'string' || !FILL_KINDS.has(f.kind) || !isStr(f.key) || !isStr(f.value) || !isProb(f.p)) return null
    seen.add(f.index)
    fills.push({ index: f.index, kind: f.kind as FillPlan['fills'][number]['kind'], key: f.key, value: f.value, p: f.p })
  }
  const left: FillPlan['left'] = []
  for (const l of raw.left) {
    if (!isObj(l) || !isIndex(l.index) || typeof l.reason !== 'string' || !LEFT_REASONS.has(l.reason)) return null
    left.push({ index: l.index, reason: l.reason as FillPlan['left'][number]['reason'] })
  }
  return { fills, left }
}

// ---------------------------------------------------------------------------
// The service-worker side
// ---------------------------------------------------------------------------

const defaultSend = (msg: DeciderRelayMsg): unknown => chrome.runtime.sendMessage(msg)
/** A request: resolves with the panel listener's sendResponse value. */
const defaultRequest = (msg: MapFormRequest): Promise<unknown> => chrome.runtime.sendMessage(msg)

/** Start the select-options read NOW (issued before this returns); never rejects — `{}` on failure. */
function selectOptionsNow(tabId: number, elements: DecisionElement[]): Promise<Record<number, string[]>> {
  try {
    const indices = selectIndicesOf(elements)
    return readSelectOptions(tabId, indices).then(
      (o) => (o && typeof o === 'object' ? o : {}),
      () => ({}),
    )
  } catch {
    return Promise.resolve({})
  }
}

const NO_PANEL = 'no Lychee panel is open to run the decision model'
/** mapForm's answer once its caller's signal aborted (Stop). Shared with the panel's own mapForm. */
export const STOPPED = 'the turn was stopped'

/** The request's own values, within what parseMapFormRequest accepts: anything else is dropped. */
function requestValues(values: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(values ?? {})) {
    if (Object.keys(out).length >= MAX_VALUES) break
    if (k !== '' && k.length <= MAX_KEY && isStr(v)) out[k] = v
  }
  return out
}

/** Why a request failed, worded for the model ("Could not map fields automatically (<this>)…"). */
function requestFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/Receiving end does not exist|Could not establish connection|message port closed/i.test(message)) return NO_PANEL
  return message.slice(0, 200)
}

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
  /** Assist's round trip; defaults to chrome.runtime.sendMessage with a response. */
  request?: (msg: MapFormRequest) => Promise<unknown>
  /** Defaults to MAP_FORM_TIMEOUT_MS. */
  mapFormTimeoutMs?: number
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
    // Like observeStep: the select options are read here, before the fill types anything, and
    // the observation is posted when that read settles. Sensitive fields never leave the worker.
    observeFill(i) {
      try {
        if (!on()) return
        const snap = formSnapOf(i.snap)
        const fields = observedFields(i.fields, snap.elements)
        if (fields.length === 0) return
        const plan = i.session.plan
        void selectOptionsNow(i.tabId, snap.elements).then((selectOptions) =>
          post({ type: 'decider.fill', conversationId: deps.conversationId, fill: { tabId: i.tabId, snap, plan, selectOptions, fields } }),
        )
      } catch {
        /* additive only */
      }
    },

    // Assist: ask the panel for a plan and wait for it — this one IS awaited, by an AutofillForm
    // call that brought no fields of its own. Every failure resolves `{ error }` (never rejects),
    // and the plan is rebuilt against this worker's own snapshot before anything acts on it.
    // The wait ends early when `i.signal` aborts (Stop). Whenever this side gives up — abort or
    // timeout — it tells the panel (`decider.mapForm.cancel`), which then drops the request: no
    // more work, no reply plan, no fill record for a plan nobody will apply.
    async mapForm(i) {
      try {
        if (settingsModeOf(deps.settings) !== 'assist') return { error: 'the decision model is not in Assist mode' }
        if (i.signal?.aborted) return { error: STOPPED }
        const snap = formSnapOf(i.snap)
        const selectOptions = await selectOptionsNow(i.tabId, snap.elements)
        if (i.signal?.aborted) return { error: STOPPED }
        const requestId = crypto.randomUUID()
        const built: MapFormRequest = {
          type: 'decider.mapForm',
          conversationId: deps.conversationId,
          requestId,
          tabId: i.tabId,
          snap,
          plan: i.session.plan,
          selectOptions,
          values: requestValues(i.values),
        }
        // The panel ignores what its validator rejects, so never send what it would reject: that
        // would cost the whole timeout to learn nothing. (A JSON round trip, as the channel makes.)
        const msg = parseMapFormRequest(JSON.parse(JSON.stringify(built)))
        if (!msg) return { error: 'the form is too large to send to the decision model' }
        let timer: ReturnType<typeof setTimeout> | undefined
        let onAbort: (() => void) | undefined
        const gaveUp = new Promise<'timeout' | 'aborted'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), deps.mapFormTimeoutMs ?? MAP_FORM_TIMEOUT_MS)
          onAbort = () => resolve('aborted')
          i.signal?.addEventListener('abort', onAbort, { once: true })
        })
        let reply: unknown
        try {
          reply = await Promise.race([Promise.resolve().then(() => (deps.request ?? defaultRequest)(msg)), gaveUp])
        } catch (err) {
          return { error: requestFailure(err) }
        } finally {
          clearTimeout(timer)
          if (onAbort) i.signal?.removeEventListener('abort', onAbort)
        }
        if (reply === 'timeout' || reply === 'aborted') {
          post({ type: 'decider.mapForm.cancel', conversationId: deps.conversationId, requestId })
          return { error: reply === 'timeout' ? 'the decision model did not answer in time' : STOPPED }
        }
        if (reply === undefined || reply === null) return { error: NO_PANEL }
        if (!isObj(reply) || reply.requestId !== requestId) return { error: 'the panel sent a malformed reply' }
        if (typeof reply.error === 'string') return { error: reply.error.slice(0, 300) }
        const plan = parseFillPlan(reply.plan, new Set(snap.elements.map((e) => e.index)))
        return plan ?? { error: 'the panel sent a malformed plan' }
      } catch (err) {
        return { error: requestFailure(err) }
      }
    },
  }
}
