// The candidate-action layer's first half: domIndex's raw registry
// (PageSnapshot) becomes a BrowserObservation — every indexed element as a
// control with a role, its states, the actions it can support, and a
// fingerprint — plus the page's scroll state and a semantic hash. Pure: no
// Chrome, no model. The second half (candidates.ts) turns an observation into
// the finite space a policy may choose from.
//
// A control's `id` IS the domIndex index, rendered "[N]": the chat model's
// ControlPage addresses the same thing, so an `uncertain` hand-back and the
// LLM fallback choose from exactly the candidates Von saw.
import type { IndexedElement, PageSnapshot } from '../platform/domIndex'

export type ElementAction = 'click' | 'type_text' | 'select_option'

/** Exactly the field set pageControl's hasElementChanged compares. */
export interface ControlFingerprint {
  tag: string
  type?: string
  name: string
  href?: string
  sensitive: boolean
  /** A toggle's state at observation time: flipped since → the target is stale. */
  checked?: boolean
  /** Disabled at observation time (never, for a candidate); enabled → disabled since → stale. */
  disabled?: true
}

export interface BrowserControl {
  id: number
  /** What the element's own nature implies (opFor): a field is typed into, a <select> selected from, the rest clicked. */
  kind: 'click' | 'type' | 'select'
  /** The page's own ARIA role, else derived from tag/type ("button", "textbox", "checkbox", "link", "combobox", "email field"…). */
  role: string
  name: string
  /** Current value of a field. Never for a checkbox/radio (see `checked`) and never for a sensitive control. */
  value?: string
  checked?: boolean
  /** Own name of the nearest named ancestor (a form, dialog or delegating container) — domIndex's ancestorName. */
  group?: string
  sensitive: boolean
  states: { enabled: boolean; editable: boolean; focused: boolean }
  /** Capabilities independent of the task: empty when sensitive or disabled; no type_text when read-only. */
  actions: ElementAction[]
  fingerprint: ControlFingerprint
}

export interface BrowserObservation {
  page: { url: string; origin: string; title: string }
  state: { canScrollUp: boolean; canScrollDown: boolean; focusedId?: number; truncated: boolean }
  controls: BrowserControl[]
  /** Semantic hash (url + each control's role/name/value/checked) — loop detection, never raw DOM. */
  hash: string
}

const TEXT_INPUT = new Set(['', 'text', 'email', 'search', 'tel', 'url', 'number', 'date', 'time', 'datetime-local', 'month', 'week'])

/** The one operation an element's own nature implies: a field is typed into, a <select> is selected from, everything else is clicked. */
export function opFor(el: Pick<IndexedElement, 'tag' | 'type' | 'role'>): 'click' | 'type' | 'select' {
  const tag = el.tag.toLowerCase()
  if (tag === 'select') return 'select'
  if (tag === 'textarea') return 'type'
  if (tag === 'input' && TEXT_INPUT.has((el.type ?? '').toLowerCase())) return 'type'
  if (el.role === 'textbox' || el.role === 'searchbox') return 'type'
  return 'click'
}

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function roleOf(el: IndexedElement): string {
  if (el.role) return el.role
  const tag = el.tag.toLowerCase()
  if (tag === 'a') return 'link'
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (tag !== 'input') return tag
  const t = (el.type ?? 'text').toLowerCase()
  if (t === 'checkbox' || t === 'radio') return t
  if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button'
  if (t === 'password') return 'password field'
  if (t === 'search') return 'searchbox'
  if (t === '' || t === 'text') return 'textbox'
  return `${t} field`
}

export function buildControl(el: IndexedElement, focusedIndex: number | undefined): BrowserControl {
  const op = opFor(el)
  const enabled = el.disabled !== true
  const editable = op !== 'click' && el.readonly !== true
  const toggle = el.checked !== undefined
  const actions: ElementAction[] = []
  if (!el.sensitive && enabled) {
    actions.push('click')
    if (op === 'type' && editable) actions.push('type_text')
    if (op === 'select' && editable) actions.push('select_option')
  }
  const control: BrowserControl = {
    id: el.index,
    kind: op,
    role: roleOf(el),
    name: el.name,
    sensitive: el.sensitive,
    states: { enabled, editable, focused: el.index === focusedIndex },
    actions,
    fingerprint: { tag: el.tag, type: el.type, name: el.name, href: el.href, sensitive: el.sensitive, checked: el.checked, disabled: el.disabled },
  }
  if (toggle) control.checked = el.checked
  else if (el.value && !el.sensitive) control.value = el.value
  if (el.ancestorName) control.group = el.ancestorName
  return control
}

/** FNV-1a 32-bit as 8 hex chars. Deterministic and dependency-free; not cryptographic and not meant to be. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Scroll position is deliberately NOT part of the hash: a scroll that reveals
 * no new control is "no change", and the candidate space then withholds
 * SCROLL_DOWN because the page reports it cannot scroll further.
 */
export function observationHash(url: string, controls: readonly BrowserControl[]): string {
  const lines = controls.map((c) => `${c.role}\t${c.name}\t${c.value ?? ''}\t${c.checked === undefined ? '' : c.checked ? '1' : '0'}`)
  return fnv1a(`${url}\n${lines.join('\n')}`)
}

export function buildObservation(snap: PageSnapshot): BrowserObservation {
  const controls = snap.elements.map((el) => buildControl(el, snap.focusedIndex))
  // An older caller (or a page where the walker could not measure) reports no
  // scroll facts: assume both directions are possible rather than removing a
  // move the page may need.
  const canScrollUp = snap.scroll ? snap.scroll.y > 0 : true
  const canScrollDown = snap.scroll ? snap.scroll.y < snap.scroll.max - 1 : true
  return {
    page: { url: snap.url, origin: snap.origin, title: snap.title },
    state: { canScrollUp, canScrollDown, focusedId: snap.focusedIndex, truncated: snap.truncated },
    controls,
    hash: observationHash(snap.url, controls),
  }
}
