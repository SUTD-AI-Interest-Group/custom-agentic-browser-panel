// Pure conversion of Mind2Web action steps into the fine-tune pipeline's
// pages.jsonl / episodes.jsonl shape. The registry half mirrors what
// src/platform/domIndex.ts records on a live page — same name order, the
// same `type` defaults the DOM applies, the SAME sensitivity regexes (copied
// verbatim; mind2web-lib.test.mjs asserts they equal the source) — because a
// training row must describe a control exactly as the browser will at
// inference. What cleaned_html no longer carries (href, disabled, readonly,
// form method, onclick) stays absent rather than guessed.
import { JSDOM } from 'jsdom'
import { siteKey } from './lib.mjs'

export { siteKey }

export const VIEWPORT = { width: 1280, height: 720 } // Playwright's default; the <html> rect confirms 1280
export const MAX_ELEMENTS = 200 // domIndex's cap per snapshot
export const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea'])
export const SAME_CLASS_DECOYS = 40

// ---- copied from src/platform/domIndex.ts buildInteractiveIndex() — keep byte-identical ----
export const SENSITIVE_RE =
  /card|cvv|ccv|\bcvc2?\b|ssn|passw|social security|routing|account\s*(number|no|num)\b|\bcc[-_]?(num|number|no)\b|\bacct|\bpin\b|security code|\botp\b|verification code|one[-\s]?time|iban|sort code/i
export const SWIFT_BIC_RAW_RE = /\bswift[-_]?code\b|\bbic[-_]?code\b/i
export const INTERACTIVE_ROLES =
  /^(button|link|checkbox|radio|tab|menuitem|switch|option|combobox|textbox)$/i
export const normalizeForSensitivity = (s) =>
  s
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
const isBareSwiftOrBic = (s) => {
  const t = String(s).trim().toLowerCase()
  return t === 'swift' || t === 'bic'
}
// ---- end of copy ----

// observation.ts's TEXT_INPUT/opFor, mirrored for the op-mismatch check (the renderer re-derives it from the shipped code).
const TEXT_INPUT = new Set(['', 'text', 'email', 'search', 'tel', 'url', 'number', 'date', 'time', 'datetime-local', 'month', 'week'])
export function opFor(el) {
  if (el.tag === 'select') return 'select'
  if (el.tag === 'textarea') return 'type'
  if (el.tag === 'input' && TEXT_INPUT.has((el.type ?? '').toLowerCase())) return 'type'
  if (el.role === 'textbox' || el.role === 'searchbox') return 'type'
  return 'click'
}

export const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
/** Placeholder origin (spec open item 2): plausible, never a synthetic TLD the model could learn as a corpus marker. */
export const originFor = (website) => `https://www.${website.includes('.') ? website : `${website}.com`}`

export function parseRect(s) {
  const [x, y, width, height] = String(s ?? '-1,-1,-1,-1').split(',').map(Number)
  return { x, y, width, height }
}
export const visible = (r) => r.x >= 0 && r.y >= 0 && r.width >= 4 && r.height >= 4 // domIndex drops < 4 px

/** A pos/neg candidate — the dataset ships each as one JSON string whose `attributes` is itself a JSON string. */
export function parseCandidate(raw) {
  const c = typeof raw === 'string' ? JSON.parse(raw) : raw
  const attrs = typeof c.attributes === 'string' ? JSON.parse(c.attributes) : (c.attributes ?? {})
  return { tag: String(c.tag).toLowerCase(), nodeId: String(c.backend_node_id ?? attrs.backend_node_id), attrs, rect: parseRect(attrs.bounding_box_rect), isOriginal: !!c.is_original_target }
}
export function pickTarget(pos) {
  const vis = pos.filter((p) => visible(p.rect))
  return vis.find((p) => p.isOriginal) ?? vis[0]
}

const REPR = /^\[([^\]]*)\]\s*(.*?)\s*->\s*(CLICK|TYPE|SELECT)(?::\s*(.*))?$/s
export function parseRepr(s) {
  const m = REPR.exec(String(s ?? '').trim())
  if (!m) return undefined
  return { role: m[1].trim(), name: collapse(m[2]), op: m[3], value: collapse(m[4] ?? '') }
}

function typeOf(tag, a) {
  if (tag === 'input') return (a.type ?? 'text').toLowerCase()
  if (tag === 'button') return (a.type ?? 'submit').toLowerCase() // HTMLButtonElement.type defaults to "submit"
  if (tag === 'select') return a.multiple !== undefined ? 'select-multiple' : 'select-one'
  if (tag === 'textarea') return 'textarea'
  return undefined
}

/** domIndex's accessibleName: aria-label, else innerText / placeholder / value / title / name. alt is deliberately not a name there either. */
function accessibleName(el, tag, a) {
  if (a.aria_label) return String(a.aria_label).trim().slice(0, 120)
  const text = tag === 'input' || tag === 'textarea' ? '' : collapse(el.textContent)
  const toggle = tag === 'input' && /^(checkbox|radio)$/i.test(a.type ?? '')
  const raw = a.input_value ?? a.value ?? ''
  const value = toggle && raw === 'on' ? '' : raw
  return String(text || a.placeholder || value || a.title || a.name || '').slice(0, 120)
}

function optionsOf(el) {
  return Array.from(el.querySelectorAll('option')).map((o) => ({
    value: o.getAttribute('value') ?? collapse(o.textContent),
    text: collapse(o.textContent),
    selected: o.hasAttribute('option_selected') || o.hasAttribute('selected'),
  }))
}

function valueOf(tag, a, el) {
  if (tag === 'select') {
    const opts = optionsOf(el)
    const sel = opts.find((o) => o.selected) ?? opts[0] // a select-one always has a selection
    return sel ? sel.value.slice(0, 80) : undefined
  }
  const v = a.input_value ?? a.value
  return v ? String(v).slice(0, 80) : undefined
}

function sensitiveOf(el, tag, a, accessible) {
  const type = typeOf(tag, a)
  const nameAttr = a.name ?? ''
  const idAttr = a.id ?? ''
  const nameId = `${nameAttr} ${idAttr}`
  const aria = a.aria_label ?? ''
  const ph = a.placeholder ?? ''
  const wrapping = el.closest('label')
  const labelForText = wrapping ? collapse(wrapping.textContent).slice(0, 200) : '' // cleaned_html keeps no `for`
  const labelledByText = '' // aria-labelledby is stripped
  const labelText = [aria, ph, accessible, labelForText, labelledByText].join(' ')
  return (
    type === 'password' ||
    SENSITIVE_RE.test(nameId) ||
    SENSITIVE_RE.test(labelText) ||
    SENSITIVE_RE.test(normalizeForSensitivity(`${nameId} ${labelText}`)) ||
    SWIFT_BIC_RAW_RE.test(nameId) ||
    SWIFT_BIC_RAW_RE.test(labelText) ||
    [nameAttr, idAttr, aria, ph, accessible, labelForText, labelledByText].some(isBareSwiftOrBic)
  )
}

const dialogTitleOf = (d) => {
  const aria = d.getAttribute('aria_label')
  if (aria) return aria.trim().slice(0, 120)
  const h = d.querySelector('h1,h2,h3,h4,h5,h6')
  return h ? collapse(h.textContent).slice(0, 120) : ''
}
/** domIndex's ancestorNameOf over Mind2Web's underscore attribute names. */
function ancestorNameOf(el) {
  let node = el.parentElement
  let depth = 0
  while (node && depth++ < 40) {
    const role = (node.getAttribute('role') || '').toLowerCase()
    if (node.tagName === 'FORM') {
      const aria = node.getAttribute('aria_label')
      if (aria) return aria.trim().slice(0, 120)
    } else if (role === 'dialog' || role === 'alertdialog') {
      const t = dialogTitleOf(node)
      if (t) return t
    } else if (node.hasAttribute('onclick') || /^(button|link|menuitem)$/.test(role)) {
      const aria = node.getAttribute('aria_label')
      if (aria) return aria.trim().slice(0, 120)
    }
    node = node.parentElement
  }
  return ''
}

/**
 * Which candidates the registry lists. The target always; otherwise what
 * domIndex's isInteractive would accept from the attributes that survive
 * cleaning, plus two decoy rules so the target is never the only element of
 * its kind (21% of Mind2Web click targets are div/li/span/svg with no
 * interactive attribute; without decoys the odd role out would give the
 * answer away).
 */
function registered(c, el, target, targetEl, sameClass) {
  if (target && c.nodeId === target.nodeId) return true
  if (c.tag === 'option' || c.tag === 'html' || c.tag === 'body') return false
  if (INTERACTIVE_TAGS.has(c.tag)) return true
  if (INTERACTIVE_ROLES.test(c.attrs.role ?? '')) return true
  if (c.attrs.is_clickable === 'true') return true
  if (target && c.tag === target.tag) {
    if (targetEl && el.parentElement && el.parentElement === targetEl.parentElement) return true
    if (c.attrs.class && c.attrs.class === target.attrs.class && sameClass.n++ < SAME_CLASS_DECOYS) return true
  }
  return false
}

/**
 * The page's registry in document order (unindexed — indexing happens per
 * viewport) plus its title and height. `candidates` is pos ∪ neg for the
 * step; `targetNodeId` marks the human's target so it is always registered
 * and its decoys are pulled in.
 */
export function buildRegistry(html, candidates, targetNodeId) {
  const dom = new JSDOM(html)
  try {
    const doc = dom.window.document
    const byNode = new Map(candidates.filter((c) => visible(c.rect)).map((c) => [c.nodeId, c]))
    const target = targetNodeId !== undefined ? byNode.get(targetNodeId) : undefined
    const targetEl = target ? doc.querySelector(`[backend_node_id="${target.nodeId}"]`) : null
    const titleEl = doc.querySelector('title')
    const title = titleEl ? collapse(titleEl.textContent.replace(/<[^>]+>/g, '')) : ''
    const root = candidates.find((c) => c.tag === 'html') ?? candidates.find((c) => c.tag === 'body')
    const scrollHeight = Math.max(root ? root.rect.height : 0, ...candidates.map((c) => (visible(c.rect) ? c.rect.y + c.rect.height : 0)), VIEWPORT.height)
    const sameClass = { n: 0 }
    const elements = []
    for (const el of doc.querySelectorAll('[backend_node_id]')) {
      const c = byNode.get(el.getAttribute('backend_node_id'))
      if (!c || !registered(c, el, target, targetEl, sameClass)) continue
      // The node's own attributes (type, name, placeholder, aria_label, value,
      // input_value, input_checked, role, title…) overlaid with the candidate's
      // (the same, plus is_clickable and the rect, which only the candidate has).
      const a = { ...Object.fromEntries(Array.from(el.attributes, (x) => [x.name, x.value])), ...c.attrs }
      const type = typeOf(c.tag, a)
      const name = accessibleName(el, c.tag, a)
      const toggle = c.tag === 'input' && /^(checkbox|radio)$/i.test(type ?? '')
      const form = el.closest('form')
      elements.push({
        nodeId: c.nodeId,
        tag: c.tag,
        role: a.role || undefined,
        name,
        type,
        value: toggle ? undefined : valueOf(c.tag, a, el),
        checked: toggle ? a.input_checked === 'true' : undefined,
        sensitive: sensitiveOf(el, c.tag, a, name),
        ancestorName: ancestorNameOf(el) || undefined,
        form: form ? (form.getAttribute('backend_node_id') ?? undefined) : undefined,
        options: c.tag === 'select' ? optionsOf(el) : undefined,
        rect: c.rect,
      })
    }
    return { title, scrollHeight: Math.round(scrollHeight), elements }
  } finally {
    dom.window.close()
  }
}

// ---------------------------------------------------------------------------
// Viewports, goals, value keys and episodes.

export const SPLIT_OF = { train: 'train', test_task: 'train', test_domain: 'train', test_website: 'val' }
const WRITER = 'dataset:mind2web'
const ACTION_OF_OP = { CLICK: 'click', TYPE: 'type', SELECT: 'select' }
const OPERATION_OF_OP = { CLICK: 'CLICK', TYPE: 'TYPE_TEXT', SELECT: 'SELECT_OPTION' }

const slim = (e, index, scrollY) => {
  const { rect, ...rest } = e
  const out = { index, ...rest, y: Math.round(rect.y - scrollY) }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out
}

/**
 * One or two windows over the page; the target must be visible in one — a
 * reconstruction, not a scroll trace. Window 0 is the top of the page; a
 * below-fold target gets a second window a third of a screen above it.
 * Each window is capped like a real snapshot (MAX_ELEMENTS, document order),
 * and a target past the cap is reported absent, never pulled forward.
 */
export function bucketViewports(registry, targetNodeId, scrollHeight, vh = VIEWPORT.height) {
  const target = registry.elements.find((e) => e.nodeId === targetNodeId)
  const maxScroll = Math.max(0, scrollHeight - vh)
  const offsets = [0]
  if (target && target.rect.y + target.rect.height > vh * 0.9) {
    const y = Math.min(maxScroll, Math.max(0, Math.round(target.rect.y - vh / 3)))
    if (y > 0) offsets.push(y)
  }
  const viewports = offsets.map((scrollY) => {
    const inWin = registry.elements.filter((e) => e.rect.y < scrollY + vh && e.rect.y + e.rect.height > scrollY)
    const kept = inWin.slice(0, MAX_ELEMENTS)
    return { scrollY, truncated: inWin.length > kept.length, elements: kept.map((e, i) => slim(e, i, scrollY)) }
  })
  let targetVp
  let targetIndex
  for (let i = viewports.length - 1; i >= 0; i--) {
    const hit = viewports[i].elements.find((e) => e.nodeId === targetNodeId)
    if (hit) {
      targetVp = i
      targetIndex = hit.index
      break
    }
  }
  const tname = (target?.name ?? '').toLowerCase()
  const sameNameOnTop = !!target && targetVp !== 0 && !!tname && viewports[0].elements.some((e) => e.nodeId !== targetNodeId && (e.name ?? '').toLowerCase() === tname)
  return { viewports, targetVp, targetIndex, sameNameOnTop }
}

/** snake_case ≤ 30 chars, `value` when empty, `_2`… on collision (records the key in `taken`). */
export function keyFor(name, taken) {
  const base = collapse(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30).replace(/_+$/g, '') || 'value'
  let key = base
  for (let n = 2; taken.has(key); n++) key = `${base.slice(0, 30 - String(n).length - 1)}_${n}`
  taken.add(key)
  return key
}

const pick = (xs, r) => xs[Math.floor(r() * xs.length)]
const q = (s, r) => (r() < 0.5 ? `"${s}"` : s)
const CLICK_TEMPLATES = {
  link: ['Open {n}', 'Go to {n}', 'Click the {n} link'],
  button: ['Click {n}', 'Press the {n} button', 'Hit {n}'],
  checkbox: ['Tick {n}', 'Check the {n} box', 'Select {n}'],
  radio: ['Choose {n}', 'Select the {n} option'],
  tab: ['Switch to the {n} tab', 'Open the {n} tab'],
  option: ['Choose {n}', 'Pick {n}', 'Select {n} from the list'],
  menuitem: ['Choose {n} from the menu', 'Pick {n}'],
  li: ['Choose {n}', 'Pick {n}', 'Select {n} from the list'],
  default: ['Click {n}', 'Select {n}', 'Open {n}'],
}
const TYPE_WITH = ['Type {v} into {n}', 'Enter {v} in the {n} field', 'Fill in {n} with {v}']
const TYPE_SEARCH = ['Search for {v}', 'Look up {v}']
const TYPE_WITHOUT = ['Fill in the {n} field', 'Enter a value in {n}', 'Type into {n}']
const SELECT_WITH = ['Select {v} from the {n} dropdown', 'Set {n} to {v}', 'Choose {v} under {n}']
const SELECT_WITHOUT = ['Pick an option in the {n} dropdown', 'Choose a value for {n}']

/** A templated, deterministic per-step goal from Mind2Web's own element description. */
export function stepGoal({ op, roleWord, name, value, withValue }, r) {
  const n = q(collapse(name).slice(0, 60), r)
  const v = q(collapse(value).slice(0, 60), r)
  let t
  if (op === 'CLICK') t = pick(CLICK_TEMPLATES[roleWord] ?? CLICK_TEMPLATES.default, r)
  else if (op === 'TYPE') t = withValue ? pick(/search/i.test(`${roleWord} ${name}`) && r() < 0.5 ? TYPE_SEARCH : TYPE_WITH, r) : pick(TYPE_WITHOUT, r)
  else t = withValue ? pick(SELECT_WITH, r) : pick(SELECT_WITHOUT, r)
  return t.replace('{n}', n).replace('{v}', v)
}

const shuffleEntries = (obj, r) => {
  const a = Object.entries(obj)
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return Object.fromEntries(a)
}

const reprOf = (s) => parseRepr(s.target_action_reprs) ?? parseRepr(s.action_reprs[s.target_action_index])

/**
 * All the steps of one Mind2Web task → pages (one per converted step) and
 * episodes in both goal kinds: the templated per-step goal (no history,
 * unambiguous, like the teacher corpus) and the task's own description with
 * the trajectory so far as history (the multi-field-form signal). Rows may
 * arrive in any order. Every skip is counted, and a skipped step still lends
 * its value key to the task and its line to later steps' history (without
 * an index, since it has no page).
 */
export function convertTask(rows, { rng: r }) {
  const steps = [...rows].sort((a, b) => a.target_action_index - b.target_action_index)
  const skipped = {}
  const warnings = {}
  const count = (m, k) => {
    m[k] = (m[k] ?? 0) + 1
  }
  const pages = []
  const episodes = []
  if (!steps.length) return { pages, episodes, skipped, warnings }
  const first = steps[0]
  const website = first.website
  const origin = originFor(website)
  const split = SPLIT_OF[first.split] ?? 'train'
  // Value keys for the whole task, from Mind2Web's own element descriptions (present even for skipped steps).
  const taken = new Set()
  const keyOfStep = new Map()
  const taskValues = {}
  for (const s of steps) {
    if (s.operation.op !== 'TYPE' && s.operation.op !== 'SELECT') continue
    const key = keyFor(reprOf(s)?.name ?? '', taken)
    keyOfStep.set(s.target_action_index, key)
    taskValues[key] = s.operation.value
  }
  const history = []
  for (const s of steps) {
    const op = s.operation.op
    const repr = reprOf(s) ?? { role: '', name: '', op, value: s.operation.value }
    const hist = { action: ACTION_OF_OP[op] ?? 'click', label: repr.name.slice(0, 60), valueKey: keyOfStep.get(s.target_action_index) }
    const done = () => {
      history.push(Object.fromEntries(Object.entries(hist).filter(([, v]) => v !== undefined)))
    }
    if (s.operation.original_op === 'ENTER') { count(skipped, 'enter'); done(); continue }
    const pos = s.pos_candidates.map(parseCandidate)
    const neg = s.neg_candidates.map(parseCandidate)
    const target = pickTarget(pos)
    if (!target) { count(skipped, 'no-target'); done(); continue }
    const registry = buildRegistry(s.cleaned_html, [...pos, ...neg], target.nodeId)
    const tEl = registry.elements.find((e) => e.nodeId === target.nodeId)
    if (!tEl) { count(skipped, 'target-unregistered'); done(); continue }
    const kind = opFor(tEl)
    if ((op === 'TYPE' && kind !== 'type') || (op === 'SELECT' && kind !== 'select')) { count(skipped, `op-mismatch:${op}:${tEl.tag}`); done(); continue }
    if (!repr.name || !tEl.name) { count(skipped, 'unnamed-target'); done(); continue }
    const { viewports, targetVp, targetIndex, sameNameOnTop } = bucketViewports(registry, target.nodeId, registry.scrollHeight)
    if (targetVp === undefined) { count(skipped, 'target-truncated'); done(); continue }
    if (op === 'SELECT' && !tEl.options?.some((o) => o.text === s.operation.value || o.value === s.operation.value)) count(warnings, 'select-value-not-in-options')
    hist.index = targetIndex
    const pageId = `m2w:${s.annotation_id}:${s.action_uid}`
    const title = registry.title || website
    pages.push({
      pageId, corpus: 'mind2web', url: `${origin}/`, finalUrl: `${origin}/`, site: website, split, category: s.domain, subdomain: s.subdomain,
      task: s.confirmed_task, stepIndex: s.target_action_index, stepCount: s.action_reprs.length, depth: s.target_action_index,
      innerHeight: VIEWPORT.height, scrollHeight: registry.scrollHeight, viewportInferred: true, originPlaceholder: true,
      viewports: viewports.map((v) => ({ scrollY: v.scrollY, title, origin, url: `${origin}/`, truncated: v.truncated, elements: v.elements })),
    })
    const base = { pageId, corpus: 'mind2web', split, site: website, category: s.domain, subdomain: s.subdomain, writer: WRITER, verifier: WRITER }
    const key = keyOfStep.get(s.target_action_index)
    const field = op !== 'CLICK'
    // Distractors for the step goal are the task's OTHER values (document order, at most two): realistic, and rarely more exist.
    const distractors = Object.fromEntries(Object.entries(taskValues).filter(([k]) => k !== key).slice(0, 2))
    const emit = (goalKind, goal, values, hist0, vp) => {
      const b = { ...base, goalKind, goal, vp, values, steps: hist0 }
      episodes.push({ ...b, kind: 'target', label: targetIndex, op: OPERATION_OF_OP[op] })
      if (field && Object.keys(values).length >= 2) episodes.push({ ...b, kind: 'value', field: targetIndex, label: key })
      episodes.push({ ...b, kind: 'move', label: 'act' })
      if (vp > 0 && !sameNameOnTop) episodes.push({ ...b, vp: 0, kind: 'move', label: 'scroll_down' })
    }
    // Step goal: this step's own human description, no history. Half the field goals hide the value: those get a BLOCKED twin without it.
    const withValue = !field || r() < 0.5
    const goal = stepGoal({ op, roleWord: repr.role, name: repr.name, value: s.operation.value, withValue }, r)
    const stepValues = field ? shuffleEntries({ [key]: s.operation.value, ...distractors }, r) : {}
    emit('step', goal, stepValues, [], targetVp)
    if (field && !withValue) episodes.push({ ...base, goalKind: 'step', goal, vp: targetVp, values: distractors, steps: [], kind: 'move', label: 'BLOCKED' })
    // Task goal: the whole task with the trajectory so far.
    emit('task', s.confirmed_task, shuffleEntries(taskValues, r), history.map((h) => ({ ...h })), targetVp)
    done()
  }
  return { pages, episodes, skipped, warnings }
}
