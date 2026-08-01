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
   * GET search submit from a state-creating POST submit. Resolved across
   * shadow boundaries (see closestAcrossShadow in the injected walker below).
   */
  formMethod?: string
  /**
   * Own accessible name of the nearest ancestor that could be the REAL target
   * of a click on this element — the event-delegation gap: a container
   * attaches one handler (or is itself a <form>/dialog) and dispatches by
   * target, so the element actually clicked/indexed can carry an innocuous
   * name of its own while the ancestor that defines what happens doesn't. Set
   * from a <form>'s own aria-label, a dialog/alertdialog ancestor's title
   * (aria-label, else its first heading), or the nearest independently-
   * clickable ancestor's (onclick attribute, or an interactive-shaped ARIA
   * role) own aria-label — whichever is closest. Absent when no such ancestor
   * exists or none of them carries a name of its own (see ancestorNameOf
   * below for what that leaves undetectable). Raw DOM fact, not a judgement,
   * same convention as formMethod above: the committing classifiers
   * (pageControl.ts, browsePolicy.ts) decide whether this name reads as
   * committing, exactly as they already do for the element's own `name`.
   */
  ancestorName?: string
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
  // \bcc[-_]?(num|number|no)\b and \bacct catch the near-universal
  // credit-card/account abbreviations (ccNumber, cc-number, cc_num, acctNum)
  // that the literal "card"/"account" alternatives above miss entirely.
  // \bacct has no trailing \b: camelCase names (acctNum) run straight from
  // "acct" into the next word with no boundary between "t" and "N".
  const SENSITIVE_RE =
    /card|cvv|ccv|ssn|passw|social security|routing|account\s*(number|no)|\bcc[-_]?(num|number|no)\b|\bacct|\bpin\b|security code|\botp\b|verification code|one[-\s]?time|iban|sort code/i
  const INTERACTIVE_TAGS = /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/
  const INTERACTIVE_ROLES =
    /^(button|link|checkbox|radio|tab|menuitem|switch|option|combobox|textbox)$/i
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
  // Known, accepted limitation (S4 in the hardening review): this reads
  // aria-label first with no cross-check against what the element actually
  // does. A hostile page can label a "Delete account" button "Cancel" and
  // nothing in the DOM tells them apart — the same trust a screen-reader user
  // extends to a page's own labelling. Not fixable from the DOM alone; see
  // isPointOfNoReturn/isSafeResearchAction's own comments for how the
  // classifiers deliberately keep every NON-name-based check (href, type,
  // sensitive, formMethod, ancestorName's structural half) unconditional so a
  // benign-sounding name can never suppress one of those.

  // el.closest() (used for `form` below) stops dead at a shadow boundary
  // going UP the tree — the mirror image of collectAll()'s problem going
  // DOWN. A form-associated custom element whose internal submit control
  // lives in an *open* shadow root, with the real <form> in the light DOM
  // outside it, would otherwise read formMethod:undefined and silently
  // exempt a state-creating POST submit from browsePolicy's deny (S5). Retry
  // the search from the shadow host once the current tree is exhausted.
  const closestAcrossShadow = (start: Element, selector: string): Element | null => {
    let node: Element | null = start
    while (node) {
      const found = node.closest(selector)
      if (found) return found
      const root = node.getRootNode()
      node = root instanceof ShadowRoot ? root.host : null
    }
    return null
  }

  // A dialog's own "title" for ancestorNameOf below: aria-label, else the
  // element an aria-labelledby points at, else its first heading. Best
  // effort — a dialog with none of these has no discoverable title from the
  // DOM alone.
  const dialogTitleOf = (dialog: Element): string => {
    const aria = dialog.getAttribute('aria-label')
    if (aria) return aria.trim().slice(0, 120)
    const labelledBy = dialog.getAttribute('aria-labelledby')
    if (labelledBy) {
      const rootNode = dialog.getRootNode()
      const root: Document | ShadowRoot = rootNode instanceof ShadowRoot ? rootNode : document
      const ref = root.getElementById(labelledBy)
      if (ref?.textContent) return ref.textContent.trim().slice(0, 120)
    }
    const heading = dialog.querySelector('h1,h2,h3,h4,h5,h6')
    return heading?.textContent?.trim().slice(0, 120) ?? ''
  }

  /**
   * Own accessible name of the nearest ancestor that could be the REAL
   * target of a click on `start` (see the ancestorName doc on IndexedElement
   * above for why). Checks, at each level climbing up: is this a <form>
   * (its own aria-label)? a dialog/alertdialog (its title)? independently
   * clickable — onclick attribute or an interactive-shaped ARIA role — (its
   * own aria-label)? Keeps climbing past a shaped-but-nameless ancestor
   * rather than stopping there — closest NAMED ancestor wins, capped at 40
   * levels as a guard against pathological nesting. Bridges shadow
   * boundaries one level at a time (unlike closestAcrossShadow, every level
   * here needs inspecting, not just the nearest selector match).
   *
   * What this does NOT catch (S3's honest residual limit): a handler
   * attached via addEventListener with no onclick attribute, no interactive
   * role, and no aria-label anywhere in the ancestor chain — e.g. a bare
   * `<div class="row">` wrapping a plain icon, styled clickable by CSS alone
   * and wired up in JS with no accessibility annotation at all. That is
   * genuinely invisible from the DOM; there is no attribute left to read.
   */
  const ancestorNameOf = (start: Element): string => {
    let node: Element | null = start.parentElement
    if (!node) {
      const root = start.getRootNode()
      node = root instanceof ShadowRoot ? root.host : null
    }
    let depth = 0
    while (node && depth++ < 40) {
      const role = (node.getAttribute('role') || '').toLowerCase()
      if (node.tagName === 'FORM') {
        const aria = node.getAttribute('aria-label')
        if (aria) return aria.trim().slice(0, 120)
      } else if (role === 'dialog' || role === 'alertdialog') {
        const title = dialogTitleOf(node)
        if (title) return title
      } else if (node.hasAttribute('onclick') || /^(button|link|menuitem)$/.test(role)) {
        const aria = node.getAttribute('aria-label')
        if (aria) return aria.trim().slice(0, 120)
      }
      const parent: Element | null = node.parentElement
      if (parent) {
        node = parent
      } else {
        const root = node.getRootNode()
        node = root instanceof ShadowRoot ? root.host : null
      }
    }
    return ''
  }

  // Clear any stamps from a previous snapshot before re-indexing.
  document.querySelectorAll(`[${attr}]`).forEach((n) => n.removeAttribute(attr))

  // A plain querySelectorAll('*') never descends into an element's shadow
  // root (a separate tree, not part of the light DOM this walks) — so any
  // interactive element inside a web component (payment widgets, many
  // design-system components, cookie banners built as custom elements) was
  // entirely invisible to this index. Recurse into each open shadow root
  // encountered; closed shadow roots stay genuinely inaccessible, same as a
  // cross-origin iframe — an acknowledged residual limit, not fixed here.
  const collectAll = (root: ParentNode): Element[] => {
    const found: Element[] = []
    for (const el of Array.from(root.querySelectorAll('*'))) {
      found.push(el)
      if (el.shadowRoot) found.push(...collectAll(el.shadowRoot))
    }
    return found
  }

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
    ancestorName?: string
  }> = []
  const all = collectAll(document)
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
    // closestAcrossShadow's selector is a plain string (not the literal
    // 'form'), so TS can't apply closest()'s HTMLFormElement-narrowing
    // overload the way a direct el.closest('form') call would — same object
    // shape at runtime either way, just needs the cast spelled out.
    const form = closestAcrossShadow(el, 'form') as HTMLFormElement | null
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
      ancestorName: ancestorNameOf(el) || undefined,
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
