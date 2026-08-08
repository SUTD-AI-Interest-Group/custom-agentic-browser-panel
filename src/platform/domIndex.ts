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
  // "acct" into the next word with no boundary between "t" and "N". "num" is
  // added to the account alternative (not just "number"/"no") for the same
  // abbreviation reason, with a trailing \b this time — unlike \bacct, "num"
  // alone is a real word-fragment risk (accountNumeric) so it's worth
  // closing that side.
  //
  // \bcvc2?\b covers Mastercard's own term for the card security code (cvv/
  // ccv already cover the Visa/generic terms) — cvc and cvc2 are both in
  // real use, and "cvc" isn't a real English word, so it carries none of the
  // swift/bic collision risk documented on SWIFT_BIC_RAW_RE below.
  const SENSITIVE_RE =
    /card|cvv|ccv|\bcvc2?\b|ssn|passw|social security|routing|account\s*(number|no|num)\b|\bcc[-_]?(num|number|no)\b|\bacct|\bpin\b|security code|\botp\b|verification code|one[-\s]?time|iban|sort code/i

  // SENSITIVE_RE's multi-word phrases (social security, sort code, security
  // code, verification code) and the account/no/num alternatives assume a
  // literal space or nothing between words — but a real name/id/label is
  // essentially never written that way: HTML authors use kebab-case
  // (account-number), snake_case (account_number) or camelCase
  // (accountNumber, sortCode), never "account number" with an actual space.
  // Rather than hand-patch every alternative for every separator
  // convention, normalize once: collapse -/_ runs to a space and split
  // camelCase word boundaries into a space, so every convention converges
  // on the one literal-space form the phrases already expect. Callers
  // always test the RAW string too (never only the normalized one) — see
  // the sensitive computation below — so this can only add matches SENSI-
  // TIVE_RE already found some other way, never remove one.
  const normalizeForSensitivity = (s: string): string =>
    s
      .replace(/[-_]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')

  // "swift"/"bic" cannot live inside SENSITIVE_RE (tested against BOTH the
  // raw string and normalizeForSensitivity's output, above): normalization
  // exists specifically to MANUFACTURE a token boundary the raw string
  // doesn't have (accountNum -> "account Num"), and for an ordinary English
  // word/brand/framework name that happens to start with "swift"/"bic" —
  // SwiftUI, swiftAction, bicPenColor — that manufactured boundary is
  // exactly the false positive: swiftUIPreview normalizes to "swift UI
  // Preview", where a bare \bswift\b now matches a token that was never
  // actually standalone in the real id. Confirmed: raw "swiftUIPreview"
  // does not match a bare \bswift\b (no boundary between "swift" and "UI"
  // in the ORIGINAL string — both are word characters), only the
  // normalized copy does. So the compound form below is tested ONLY
  // against the raw nameId/labelText, never normalized (see the sensitive
  // computation below) — which means it must do its own separator handling
  // instead of relying on normalizeForSensitivity.
  //
  // A SECOND, separate collision (found on the raw string alone, no
  // normalization involved): a bare \bswift\b / \bbic\b regex alternative
  // fires on ANY kebab-case name that merely CONTAINS the token — "-" is a
  // non-word character, so \b is satisfied on both sides of "swift" inside
  // "swift-search", "bic-pen", "my-swift-thing" — even though the field
  // isn't swift/bic, it just has a hyphen next to that word. \b guards
  // against word-CHARACTER neighbors (arabicText, bicycle), never against a
  // hyphen neighbor, and the two cannot be told apart with more regex
  // cleverness on this string alone.
  //
  // \bswift[-_]?code\b / \bbic[-_]?code\b stay a regex (below): the
  // compound form is legitimately meant to match as a SUBSTRING anywhere in
  // a longer id (userSwiftCodeField, bic-code-x — the latter is a
  // deliberate match: it genuinely contains a "bic-code" token, not a
  // coincidental substring), requiring literal "code" immediately after an
  // optional single separator is what a genuinely unrelated compound like
  // "swift-search" can never satisfy. But the BARE form — a field that IS
  // swift/bic outright (bare "bic" is the standard label on European bank
  // forms) — has no such distinguishing suffix to anchor on, so it's
  // checked separately by isBareSwiftOrBic, exact string equality after
  // trim+lowercase, against each INDIVIDUAL source (never the concatenated
  // nameId/labelText, whose join characters make substring-based exactness
  // unreliable) — see the sensitive computation below for the source list.
  const SWIFT_BIC_RAW_RE = /\bswift[-_]?code\b|\bbic[-_]?code\b/i
  const isBareSwiftOrBic = (s: string): boolean => {
    const t = s.trim().toLowerCase()
    return t === 'swift' || t === 'bic'
  }
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

  // Perf: labelAssociationTextOf (below) used to re-run
  // `root.querySelectorAll('label')` from scratch for EVERY indexed element
  // that has an id — O(inputs × labels), measured ~1.2s on a 200-input/
  // 2000-label form vs ~150ms at 300 labels. This taxes exactly the large
  // enterprise forms AutofillForm exists for. Build one `for` → text[] map
  // per root in a single pass (piggybacked on collectAll's existing
  // querySelectorAll('*') walk below, so it costs no extra DOM traversal),
  // then look up by id in O(1). Keyed by the root's own object identity
  // (not a string) — the exact same object `el.getRootNode()` returns for
  // any element inside it — so a `for` value is never resolved against a
  // DIFFERENT shadow root's labels; each root gets its own map, preserving
  // the same per-root scoping the original per-element querySelectorAll had.
  const labelForMaps = new Map<ParentNode, Map<string, string[]>>()

  // A plain querySelectorAll('*') never descends into an element's shadow
  // root (a separate tree, not part of the light DOM this walks) — so any
  // interactive element inside a web component (payment widgets, many
  // design-system components, cookie banners built as custom elements) was
  // entirely invisible to this index. Recurse into each open shadow root
  // encountered; closed shadow roots stay genuinely inaccessible, same as a
  // cross-origin iframe — an acknowledged residual limit, not fixed here.
  const collectAll = (root: ParentNode): Element[] => {
    const found: Element[] = []
    // This root's OWN label→for map. root.querySelectorAll('*') never
    // pierces into a nested shadow root (see above), so this only ever
    // collects labels that actually live in `root` — a recursive call for
    // el.shadowRoot builds and registers its own, separate map below.
    const forMap = new Map<string, string[]>()
    for (const el of Array.from(root.querySelectorAll('*'))) {
      found.push(el)
      if (el.tagName === 'LABEL') {
        const forValue = el.getAttribute('for')
        const text = el.textContent
        if (forValue && text) {
          const list = forMap.get(forValue)
          if (list) list.push(text)
          else forMap.set(forValue, [text])
        }
      }
      if (el.shadowRoot) found.push(...collectAll(el.shadowRoot))
    }
    labelForMaps.set(root, forMap)
    return found
  }

  // C5: an element's human-readable label is very often NOT its own name/id
  // — an associated `<label for="id">` or a wrapping `<label>...<input>...
  // </label>` is standard HTML, and is exactly how most React/MUI-style
  // forms label a field whose id is machine-generated (id="mui-42").
  // accessibleName() doesn't compute either: it only reads attributes/text
  // ON the element itself. `labelForMaps` (built by collectAll, above) is
  // already scoped per root the same way closestAcrossShadow pierces shadow
  // boundaries, so a labelled control inside a web component isn't silently
  // skipped — and neither this nor the map-building above ever builds an
  // attribute-selector string from a raw, page-controlled `id` (a hostile id
  // containing a `"` could otherwise break out of a `[for="..."]` selector).
  const labelAssociationTextOf = (el: Element): string => {
    const parts: string[] = []
    if (el.id) {
      const rootNode = el.getRootNode()
      const root: Document | ShadowRoot = rootNode instanceof ShadowRoot ? rootNode : document
      const matches = labelForMaps.get(root)?.get(el.id)
      if (matches) parts.push(...matches)
    }
    const wrapping = closestAcrossShadow(el, 'label')
    if (wrapping?.textContent) parts.push(wrapping.textContent)
    return parts.join(' ').slice(0, 200)
  }

  // aria-labelledby is as mainstream a labelling mechanism as aria-label —
  // common in design systems that label a control from a separate visible
  // heading/legend element — but wasn't read anywhere in the sensitivity
  // signals. Space-separated per the ARIA spec (a control can be labelled by
  // several elements concatenated); resolves each id in the correct root,
  // same shadow-aware getElementById pattern dialogTitleOf already uses for
  // this same attribute (just generalized to multiple ids).
  const ariaLabelledByTextOf = (el: Element): string => {
    const ids = (el.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean)
    if (!ids.length) return ''
    const rootNode = el.getRootNode()
    const root: Document | ShadowRoot = rootNode instanceof ShadowRoot ? rootNode : document
    const parts: string[] = []
    for (const id of ids) {
      const ref = root.getElementById(id)
      if (ref?.textContent) parts.push(ref.textContent)
    }
    return parts.join(' ').slice(0, 200)
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
    const nameAttr = el.getAttribute('name') ?? ''
    const idAttr = el.id ?? ''
    const nameId = `${nameAttr} ${idAttr}`
    const accessible = accessibleName(el)
    // C5: aria-label and placeholder are read directly here — not only via
    // accessibleName() above — because accessibleName() returns just ONE
    // winner (aria-label first, else innerText/placeholder/value/title/
    // name): a field with both a bland aria-label and a sensitive
    // placeholder ("Card number") would otherwise have that placeholder
    // silently dropped from consideration. labelAssociationTextOf and
    // ariaLabelledByTextOf add the sources accessibleName() never computes
    // at all (label[for], a wrapping <label>, aria-labelledby — as
    // mainstream a labelling mechanism as aria-label). Every source here is
    // OR'd into `sensitive` below, never AND'd or prioritized — see
    // labelAssociationTextOf's own comment and accessibleName's S4 comment
    // above for why a label may only ADD a detection, never suppress one.
    // Kept as individual variables (not just spread into `labelText` below)
    // because isBareSwiftOrBic needs each source checked on its own — see
    // SWIFT_BIC_RAW_RE's comment above for why.
    const ariaLabelAttr = el.getAttribute('aria-label') ?? ''
    const placeholderAttr = el.getAttribute('placeholder') ?? ''
    const labelForText = labelAssociationTextOf(el)
    const labelledByText = ariaLabelledByTextOf(el)
    const labelText = [ariaLabelAttr, placeholderAttr, accessible, labelForText, labelledByText].join(' ')
    const autocomplete = el.getAttribute('autocomplete') ?? ''
    const sensitive =
      type === 'password' ||
      /^cc-/i.test(autocomplete) ||
      /\b(one-time-code|new-password|current-password)\b/i.test(autocomplete) ||
      SENSITIVE_RE.test(nameId) ||
      SENSITIVE_RE.test(labelText) ||
      SENSITIVE_RE.test(normalizeForSensitivity(`${nameId} ${labelText}`)) ||
      // Deliberately RAW only — see SWIFT_BIC_RAW_RE's own comment above for
      // why running this through normalizeForSensitivity would reintroduce
      // the swiftUIPreview/bicPenColor-style false positives it exists to
      // avoid. Fine to test against the CONCATENATED strings, unlike the
      // bare check below: a compound match is meant to fire as a substring
      // anywhere, so a join boundary can't create a false one (the space
      // joining name/id or label parts is never itself "-"/"_"/nothing, so
      // it can't complete a \bswift[-_]?code\b match that spans it).
      SWIFT_BIC_RAW_RE.test(nameId) ||
      SWIFT_BIC_RAW_RE.test(labelText) ||
      // Exact-equality bare check, run against each individual source —
      // NOT nameId/labelText, whose concatenation would make a source that
      // is JUST "swift"/"bic" indistinguishable from one that merely
      // contains it alongside other text.
      [nameAttr, idAttr, ariaLabelAttr, placeholderAttr, accessible, labelForText, labelledByText].some(
        isBareSwiftOrBic,
      )
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
      name: accessible,
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
