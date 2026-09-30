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

export function parseCandidate(c) {
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
