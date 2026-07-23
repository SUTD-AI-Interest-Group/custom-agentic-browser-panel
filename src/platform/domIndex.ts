// Indexed-DOM perception. An injected walker finds visible interactive
// elements, stamps each with data-agent-idx (so a later, separate injection
// can re-find it — chrome.scripting calls share no JS state, only the DOM),
// and returns a registry the agent reads as text or as set-of-marks.

/** One interactive element the agent can act on, addressed by `index`. */
export interface IndexedElement {
  index: number
  tag: string
  role?: string
  /** Accessible name: aria-label | visible text | placeholder | value. */
  name: string
  type?: string
  value?: string
  /** Viewport rect in CSS pixels. */
  rect: { x: number; y: number; width: number; height: number }
  /** Password/payment-like field — forces an approval card even in a session. */
  sensitive: boolean
  /** Absolute URL for anchor elements. */
  href?: string
  /**
   * Lowercased `method` of the closest ancestor <form>, absent when the element
   * is not in one. Raw DOM fact, not a judgement: the background research
   * browser's policy (src/tools/browsePolicy.ts) reads it to tell an idempotent
   * GET search submit from a state-creating POST submit.
   */
  formMethod?: string
}

/** A full read of the current page: the registry plus a compact text form. */
export interface PageSnapshot {
  url: string
  title: string
  origin: string
  dpr: number
  elements: IndexedElement[]
  text: string
  truncated: boolean
}

const MAX_ELEMENTS = 200
const ATTR = 'data-agent-idx'

// Runs inside the target page. Fully self-contained (serialized by
// executeScript). Returns raw element records + page meta.
function buildInteractiveIndex(attr: string, maxElements: number) {
  const SENSITIVE_RE =
    /card|cvv|ccv|ssn|passw|social security|routing|account\s*(number|no)|\bpin\b|security code|\botp\b|verification code|one[-\s]?time|iban|sort code/i
  const INTERACTIVE_TAGS = /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/
  const INTERACTIVE_ROLES =
    /^(button|link|checkbox|radio|tab|menuitem|switch|option|combobox|textbox)$/
  const vw = window.innerWidth
  const vh = window.innerHeight

  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return false
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return false
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0)
      return false
    // Topmost at its center — drops occluded elements. Our overlay is
    // pointer-events:none, so it never wins this hit-test.
    const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2))
    const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2))
    const top = document.elementFromPoint(cx, cy)
    return !!top && (el === top || el.contains(top) || top.contains(el))
  }

  const isInteractive = (el: Element): boolean => {
    const tag = el.tagName
    if (INTERACTIVE_TAGS.test(tag)) return true
    const role = el.getAttribute('role') ?? ''
    if (INTERACTIVE_ROLES.test(role)) return true
    if ((el as HTMLElement).isContentEditable) return true
    if (el.hasAttribute('onclick')) return true
    if (getComputedStyle(el).cursor === 'pointer' && (el as HTMLElement).offsetParent !== null)
      return true
    return false
  }

  const accessibleName = (el: Element): string => {
    const aria = el.getAttribute('aria-label')
    if (aria) return aria.trim()
    const ph = el.getAttribute('placeholder')
    const input = el as HTMLInputElement
    const text = (el as HTMLElement).innerText?.trim() || ''
    return (text || ph || input.value || el.getAttribute('title') || el.getAttribute('name') || '')
      .toString()
      .slice(0, 120)
  }

  // Clear any stamps from a previous snapshot before re-indexing.
  document.querySelectorAll(`[${attr}]`).forEach((n) => n.removeAttribute(attr))

  const out: Array<{
    index: number
    tag: string
    role?: string
    name: string
    type?: string
    value?: string
    rect: { x: number; y: number; width: number; height: number }
    sensitive: boolean
    href?: string
    formMethod?: string
  }> = []
  const all = Array.from(document.querySelectorAll('*'))
  let index = 0
  let truncated = false
  for (const el of all) {
    if (out.length >= maxElements) {
      truncated = true
      break
    }
    if (!isInteractive(el) || !isVisible(el)) continue
    const r = el.getBoundingClientRect()
    const input = el as HTMLInputElement
    const type = input.type || undefined
    const nameId = `${el.getAttribute('name') ?? ''} ${el.id ?? ''}`
    const autocomplete = el.getAttribute('autocomplete') ?? ''
    const sensitive =
      type === 'password' ||
      /^cc-/i.test(autocomplete) ||
      /\b(one-time-code|new-password|current-password)\b/i.test(autocomplete) ||
      SENSITIVE_RE.test(nameId)
    const form = el.closest('form')
    el.setAttribute(attr, String(index))
    out.push({
      index,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') ?? undefined,
      name: accessibleName(el),
      type,
      value: input.value ? String(input.value).slice(0, 80) : undefined,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      sensitive,
      href: el.tagName === 'A' ? (el as HTMLAnchorElement).href : undefined,
      // `.method` normalizes to 'get' when the attribute is absent or invalid.
      formMethod: form ? form.method.toLowerCase() : undefined,
    })
    index++
  }
  return {
    url: location.href,
    title: document.title,
    origin: location.origin,
    dpr: window.devicePixelRatio || 1,
    elements: out,
    truncated,
  }
}

// Runs inside the page: strip all stamps.
function clearAgentIndex(attr: string) {
  document.querySelectorAll(`[${attr}]`).forEach((n) => n.removeAttribute(attr))
}

/** Serialize the registry to the compact text the model reads. */
export function serializeRegistry(elements: IndexedElement[]): string {
  if (elements.length === 0) return '(no interactive elements found)'
  return elements
    .map((e) => {
      const attrs = [
        e.type && e.type !== 'text' ? e.type : '',
        e.name ? `"${e.name}"` : '',
        e.value ? `= "${e.value}"` : '',
        e.sensitive ? '(sensitive)' : '',
      ]
        .filter(Boolean)
        .join(' ')
      return `[${e.index}]<${e.tag}${e.role ? ` role=${e.role}` : ''}> ${attrs}`.trimEnd()
    })
    .join('\n')
}

/** Inject the indexer, returning the current page registry + text form. */
export async function snapshotPage(tabId: number): Promise<PageSnapshot> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: buildInteractiveIndex,
    args: [ATTR, MAX_ELEMENTS],
  })
  const raw = res?.result
  if (!raw) throw new Error('Could not read the page.')
  const elements = raw.elements as IndexedElement[]
  const truncated = raw.truncated
  return {
    url: raw.url,
    title: raw.title,
    origin: raw.origin,
    dpr: raw.dpr,
    elements,
    text: serializeRegistry(elements) + (truncated ? '\n[element list truncated]' : ''),
    truncated,
  }
}

/** Remove all agent index stamps from the page. */
export async function clearIndex(tabId: number): Promise<void> {
  await chrome.scripting
    .executeScript({ target: { tabId }, func: clearAgentIndex, args: [ATTR] })
    .catch(() => {})
}
