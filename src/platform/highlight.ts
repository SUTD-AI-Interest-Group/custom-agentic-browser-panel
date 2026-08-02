// The "show me where" highlighter: scrolls the active tab to a passage or
// region and marks it like a highlighter pen. Distinct from presence.ts (the
// agent-is-acting overlay) in two deliberate ways: it is marker-yellow, not
// agent-blue, and it OUTLIVES the turn — the whole point is that the user reads
// the marked passage after the answer lands. Cleared at the next fresh turn
// (Chat.tsx), when the side panel closes (background.ts sweeps on the panel
// port's disconnect), or by navigation wiping the page.
//
// NOTHING HERE MAY BE PINNED TO A RECORDED RECT. Both marks are drawn while the
// side panel is open and are routinely still on screen after it closes, which
// reflows the page under them — a ring frozen at the coordinates it was measured
// at ends up circling a paragraph three screens from the thing it was pointing
// at. So: text passages use the CSS Custom Highlight API (a Range registered in
// CSS.highlights + one injected ::highlight rule) and regions use an `outline`
// rule keyed off a DOM stamp — both of which the engine re-lays-out for free.
// The one thing that cannot be expressed in CSS, the floating label pill, is
// parked in an overlay root and re-placed from its anchor's LIVE rect by a
// resize/ResizeObserver sync installed alongside it.
//
// Injected functions are fully self-contained (no closures/imports); the text
// path is two injections around the pure matcher: collect node texts → match in
// the panel (findTextInChunks) → re-walk and apply. Both walks share ONE
// injected function so the node order cannot drift between them.
import { findTextInChunks } from './highlightText'

const ROOT_ID = '__agent_highlight'
const STYLE_ID = '__agent_highlight_style'
const HL_NAME = 'agent-highlight'
const REGION_ATTR = 'data-agent-region'
/** Stamped on a ringed region — the outline rule is keyed off it, so it reflows. */
const RING_ATTR = 'data-agent-hl-ring'
/** Stamped on a text mark's anchor element, so its pill can re-find it. */
const ANCHOR_ATTR = 'data-agent-hl-anchor'
/** On a pill: the selector of the anchor it must stay glued to. */
const PILL_ATTR = 'data-agent-hl-for'
// Bound the collect payload — beyond this the page is pathological.
const MAX_COLLECT_CHARS = 500_000

// Both marks' styling, passed to the injections as an arg (an injected function
// cannot close over a module const). The ring is an outline rather than an
// overlay box because an outline is laid out by the engine: it tracks reflow,
// zoom and lazy-load growth without a single line of JS.
const HL_CSS =
  `::highlight(${HL_NAME}){background-color:rgba(255,213,79,.55);color:inherit;}` +
  `[${RING_ATTR}]{outline:2.5px solid rgba(255,193,7,.95)!important;outline-offset:4px!important;}`

/** Tabs with a live highlight, so the next fresh turn can sweep them. */
const highlighted = new Set<number>()
/**
 * The same list, mirrored where the service worker can read it: when the panel
 * closes, the context holding `highlighted` is destroyed, so the worker is the
 * only thing left that can sweep the pages (see sweepHighlightsForWindow).
 */
const SESSION_KEY = 'highlightedTabs'

interface ApplyPayload {
  startChunk: number
  startOffset: number
  endChunk: number
  endOffset: number
  label: string
}

/** What the page reported about the element a region ring actually landed on. */
export interface RegionHit {
  tag: string
  /** figcaption/caption/heading/aria-label, as regionIndex named it. */
  name: string
  /** The element's visible text, collapsed and clipped. */
  text: string
  width: number
  height: number
}

/** How much of the ringed element's text to quote back at the model. */
const HIT_TEXT_CHARS = 160

/**
 * The sentence handed back to the model after a region ring lands.
 *
 * It describes the element that was ACTUALLY ringed. The alternative — echoing
 * the `[rN]` the model passed in — is what let a highlight of the wrong thing
 * read to the model as a success: asked to point at an equation on a page whose
 * equation is a KaTeX <span> (not a region at all), it ringed the nearest
 * <table>, was told "highlighted region [r4]", and reported the job done. A tool
 * that can only ever confirm the caller's own input cannot correct the caller.
 */
export function describeRegionHit(region: number, hit: RegionHit): string {
  const what = [hit.name && `“${hit.name}”`, `<${hit.tag}>`].filter(Boolean).join(' ')
  const quote = hit.text ? ` Its text reads: “${hit.text}”.` : ' It contains no text (an image or a drawing).'
  return (
    `Ringed [r${region}] on the page for the user: ${what}, ${Math.round(hit.width)}x${Math.round(hit.height)}.` +
    `${quote} CHECK THAT AGAINST WHAT YOU MEANT TO POINT AT before you tell the user it is done. If it is not the ` +
    'right spot — or if you meant a specific line of words rather than this whole block — call HighlightContent ' +
    'again with `text` quoting those words exactly, and say plainly that you are correcting the mark.'
  )
}

// One function, two modes, one TreeWalker: 'collect' returns the text-node
// strings; 'apply' re-walks the SAME filter (same function ⇒ same order), builds
// the Range from the matched (chunk, offset) endpoints, registers the CSS
// highlight, scrolls, and places the pill + glow. The filter deliberately skips
// only definitely-invisible containers (script/style/…): per-node style checks
// are expensive and any nondeterminism between the two walks would misplace the
// Range.
async function injTextHighlight(
  rootId: string,
  styleId: string,
  hlName: string,
  css: string,
  anchorAttr: string,
  pillAttr: string,
  maxChars: number,
  mode: 'collect' | 'apply',
  payload: ApplyPayload | null,
) {
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA)$/
  const nodes: Text[] = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = (node as Text).parentElement
      if (!p || SKIP.test(p.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT
      if (!(node.textContent || '').length) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let total = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text)
    total += (n.textContent || '').length
    if (total > maxChars) break
  }

  if (mode === 'collect') {
    return { texts: nodes.map((n) => n.textContent || ''), truncated: total > maxChars }
  }

  const p = payload!
  const startNode = nodes[p.startChunk]
  const endNode = nodes[p.endChunk]
  if (!startNode || !endNode) return { ok: false }
  const range = new Range()
  range.setStart(startNode, Math.min(p.startOffset, (startNode.textContent || '').length))
  range.setEnd(endNode, Math.min(p.endOffset, (endNode.textContent || '').length))

  // Custom Highlight API, feature-detected without relying on TS lib types
  // (the injected source is serialized; these globals are the page's own).
  const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  if (!HighlightCtor || !registry) return { ok: false }
  const existing = registry.get(hlName) as { add(r: Range): void } | undefined
  if (existing) existing.add(range)
  else registry.set(hlName, new HighlightCtor(range))
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = css
    document.head.appendChild(style)
  }

  // The pill has to hang off a real element so it can be re-placed after a
  // reflow; the Range itself cannot survive to a later injection. Stamp the
  // passage's parent and address the pill at that stamp.
  const anchor = range.startContainer.parentElement
  anchor?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  // Let the smooth scroll (and any lazy-load reflow it triggers) settle before
  // reading a rect — the pre-scroll one is stale by definition.
  await new Promise((r) => setTimeout(r, 700))
  const rect = range.getBoundingClientRect()
  const docX = rect.left + window.scrollX
  const docY = rect.top + window.scrollY

  let root = document.getElementById(rootId)
  if (!root) {
    root = document.createElement('div')
    root.id = rootId
    root.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483645;pointer-events:none;'
    document.documentElement.appendChild(root)
  }
  if (p.label && anchor) {
    const key = String(document.querySelectorAll('[' + anchorAttr + ']').length)
    anchor.setAttribute(anchorAttr, key)
    const pill = document.createElement('div')
    pill.setAttribute(pillAttr, '[' + anchorAttr + '="' + key + '"]')
    pill.style.cssText =
      'position:absolute;padding:3px 8px;background:#ffd54f;color:#3d2e00;border-radius:6px;' +
      'font:600 12px system-ui;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25);' +
      `transform:translateY(-130%);left:${docX}px;top:${docY}px;`
    pill.textContent = p.label
    root.appendChild(pill)
  }
  const glow = document.createElement('div')
  glow.style.cssText =
    `position:absolute;left:${docX - 6}px;top:${docY - 6}px;width:${rect.width + 12}px;` +
    `height:${rect.height + 12}px;border-radius:8px;pointer-events:none;` +
    'box-shadow:0 0 0 3px rgba(255,213,79,.9),0 0 26px 8px rgba(255,213,79,.55);'
  root.appendChild(glow)
  glow.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1600, easing: 'ease-out', fill: 'forwards' })
  setTimeout(() => glow.remove(), 1700)
  return { ok: true }
}

// Region mark: re-find the region by its [rN] stamp, scroll to it, and stamp it
// for the outline rule. No rect is recorded — the outline is the element's own,
// so it survives the reflow that closing the side panel causes. Reports back
// WHAT it marked (tag/name/text/size): a ring the model cannot see is a ring the
// model cannot discover it aimed wrong (see describeRegionHit).
async function injRegionHighlight(
  rootId: string,
  attr: string,
  ringAttr: string,
  styleId: string,
  css: string,
  anchorAttr: string,
  pillAttr: string,
  region: number,
  label: string,
  textChars: number,
) {
  const el = document.querySelector(`[${attr}="${region}"]`)
  if (!el) return { found: false }
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = css
    document.head.appendChild(style)
  }
  el.setAttribute(ringAttr, '')
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  await new Promise((r) => setTimeout(r, 700))
  const rect = el.getBoundingClientRect()

  let root = document.getElementById(rootId)
  if (!root) {
    root = document.createElement('div')
    root.id = rootId
    root.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483645;pointer-events:none;'
    document.documentElement.appendChild(root)
  }
  const pad = 5
  if (label) {
    // Anchor on OUR stamp, never on the [rN] one: buildRegionIndex wipes and
    // renumbers data-agent-region on every ReadPage(mode:"regions"), so a pill
    // addressed by region number would slide onto an unrelated element the next
    // time the model re-reads the page.
    const key = String(document.querySelectorAll('[' + anchorAttr + ']').length)
    el.setAttribute(anchorAttr, key)
    const pill = document.createElement('div')
    pill.setAttribute(pillAttr, '[' + anchorAttr + '="' + key + '"]')
    pill.style.cssText =
      'position:absolute;padding:3px 8px;background:#ffd54f;color:#3d2e00;border-radius:6px;' +
      'font:600 12px system-ui;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25);' +
      `transform:translateY(-130%);left:${rect.left + window.scrollX - pad}px;top:${rect.top + window.scrollY - pad}px;`
    pill.textContent = label
    root.appendChild(pill)
  }

  // Name it the way regionIndex named it, so the model can compare against the
  // list it was shown.
  const cap = el.querySelector('figcaption, caption')
  const heading = el.querySelector('h1, h2, h3, h4, h5, h6')
  const name = (
    (cap as HTMLElement | null)?.innerText ||
    el.getAttribute('aria-label') ||
    el.getAttribute('alt') ||
    (heading as HTMLElement | null)?.innerText ||
    el.getAttribute('title') ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  const full = ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim()
  return {
    found: true,
    tag: el.tagName.toLowerCase(),
    name,
    text: full.length > textChars ? `${full.slice(0, textChars)}…` : full,
    width: rect.width,
    height: rect.height,
  }
}

// Keep every label pill glued to its anchor across reflow.
//
// Its own injection, not a helper the other two call: executeScript serializes
// ONLY the function it is handed, so a call to a module-scope callee arrives in
// the page as an undefined identifier. Sharing this by injecting it separately
// is the one way to have it in both paths without pasting it into both.
//
// Installed once per overlay root (guarded by an attribute on the root, since
// injections share no JS state). It self-disposes when the root goes away, so
// injClear leaves nothing running.
function injPillSync(rootId: string, pillAttr: string): void {
  const root = document.getElementById(rootId)
  if (!root || root.hasAttribute('data-sync')) return
  root.setAttribute('data-sync', '')
  const sync = () => {
    // Identity, not just presence: injClear removes the root, and the next
    // highlight builds a fresh one under the SAME id. Comparing by id alone
    // would leave this sync adopting its successor's pills, so every
    // clear-then-highlight cycle would pile on another live observer.
    if (document.getElementById(rootId) !== root) {
      window.removeEventListener('resize', sync)
      ro.disconnect()
      return
    }
    root.querySelectorAll(`[${pillAttr}]`).forEach((node) => {
      const pill = node as HTMLElement
      const anchor = document.querySelector(pill.getAttribute(pillAttr) || '')
      // The anchor is gone (re-render, SPA navigation): a pill pointing at
      // nothing is worse than no pill.
      if (!anchor) {
        pill.remove()
        return
      }
      const r = anchor.getBoundingClientRect()
      pill.style.left = `${r.left + window.scrollX - 5}px`
      pill.style.top = `${r.top + window.scrollY - 5}px`
    })
  }
  const ro = new ResizeObserver(sync)
  ro.observe(document.documentElement)
  window.addEventListener('resize', sync)
}

function injClear(rootId: string, styleId: string, hlName: string, ringAttr: string, anchorAttr: string) {
  document.getElementById(rootId)?.remove()
  document.getElementById(styleId)?.remove()
  // The ring lives on the page's own elements now, so removing the stylesheet is
  // not enough — the stamps have to come off too, or a later ReadPage sees them.
  document.querySelectorAll(`[${ringAttr}]`).forEach((n) => n.removeAttribute(ringAttr))
  document.querySelectorAll(`[${anchorAttr}]`).forEach((n) => n.removeAttribute(anchorAttr))
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  registry?.delete(hlName)
  // injPillSync's self-disconnect only runs when its ResizeObserver/resize
  // listener actually fires — on a page that highlights/clears repeatedly
  // with no intervening reflow, each cycle's sync would otherwise stay alive
  // (harmlessly idle) until some unrelated later layout event. A synthetic
  // resize right after removing the root makes any stale sync notice
  // immediately instead of waiting for one.
  window.dispatchEvent(new Event('resize'))
}

/** Note a tab as highlighted, both in-panel and where the worker can see it. */
async function rememberTab(tabId: number): Promise<void> {
  highlighted.add(tabId)
  try {
    const got = await chrome.storage.session.get(SESSION_KEY)
    const ids: number[] = Array.isArray(got[SESSION_KEY]) ? got[SESSION_KEY] : []
    if (!ids.includes(tabId)) await chrome.storage.session.set({ [SESSION_KEY]: [...ids, tabId] })
  } catch {
    // Best-effort: losing the mirror only costs the panel-close sweep, and the
    // next fresh turn still clears the mark.
  }
}

/** Drop `ids` from the worker-visible mirror. */
async function forgetTabs(ids: number[]): Promise<void> {
  if (ids.length === 0) return
  try {
    const got = await chrome.storage.session.get(SESSION_KEY)
    const kept: number[] = (Array.isArray(got[SESSION_KEY]) ? got[SESSION_KEY] : []).filter(
      (id: number) => !ids.includes(id),
    )
    await chrome.storage.session.set({ [SESSION_KEY]: kept })
  } catch {
    /* best-effort */
  }
}

/** Strip every mark this module can leave behind from one tab. */
async function clearTab(tabId: number): Promise<void> {
  await chrome.scripting
    .executeScript({
      target: { tabId },
      func: injClear,
      args: [ROOT_ID, STYLE_ID, HL_NAME, RING_ATTR, ANCHOR_ATTR],
    })
    .catch(() => {})
}

/** Install the reflow-tracking pill sync (idempotent — the injection self-guards). */
async function syncPills(tabId: number): Promise<void> {
  await chrome.scripting
    .executeScript({ target: { tabId }, func: injPillSync, args: [ROOT_ID, PILL_ATTR] })
    .catch(() => {})
}

/**
 * Find `query` in the page's text and mark it: marker-yellow background via the
 * Custom Highlight API, smooth-scrolled to center, optional label pill, brief
 * glow. Returns whether it was found plus the total occurrence count (first
 * occurrence is the one marked).
 */
export async function highlightTextOnPage(
  tabId: number,
  query: string,
  label = '',
): Promise<{ found: boolean; count: number; message: string }> {
  let collected: { texts: string[]; truncated: boolean } | undefined
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injTextHighlight,
      args: [ROOT_ID, STYLE_ID, HL_NAME, HL_CSS, ANCHOR_ATTR, PILL_ATTR, MAX_COLLECT_CHARS, 'collect', null],
    })
    collected = res?.result as typeof collected
  } catch (err) {
    return {
      found: false,
      count: 0,
      message: `Cannot highlight on this page (${err instanceof Error ? err.message : 'it may be a restricted page'}).`,
    }
  }
  if (!collected) return { found: false, count: 0, message: 'Cannot read this page to highlight it.' }
  const m = findTextInChunks(collected.texts, query)
  if (!m.first) {
    return {
      found: false,
      count: 0,
      message:
        'That passage was not found on the page. Quote the text exactly as it appears (re-read with ReadPage if needed) — you may have paraphrased it.',
    }
  }
  const [applied] = await chrome.scripting.executeScript({
    target: { tabId },
    func: injTextHighlight,
    args: [
      ROOT_ID,
      STYLE_ID,
      HL_NAME,
      HL_CSS,
      ANCHOR_ATTR,
      PILL_ATTR,
      MAX_COLLECT_CHARS,
      'apply',
      { ...m.first, label },
    ],
  })
  if (!(applied?.result as { ok?: boolean } | undefined)?.ok) {
    return { found: false, count: m.count, message: 'Found the passage but could not mark it on this page.' }
  }
  await rememberTab(tabId)
  await syncPills(tabId)
  const many =
    m.count > 1
      ? ` It appears ${m.count} times; the first occurrence is marked — quote a longer stretch to pin a different one.`
      : ''
  return { found: true, count: m.count, message: `Scrolled to the passage and highlighted it for the user.${many}` }
}

/**
 * Ring one visual region ([rN] from ReadPage mode:"regions"): smooth-scroll to
 * it and outline it, with an optional label pill.
 *
 * Reports back the element it actually landed on, not the number it was asked
 * for — see describeRegionHit for why that distinction is the whole point.
 */
export async function highlightRegionOnPage(
  tabId: number,
  region: number,
  label = '',
): Promise<{ found: boolean; message: string; hit?: RegionHit }> {
  let hit: RegionHit | undefined
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injRegionHighlight,
      args: [
        ROOT_ID,
        REGION_ATTR,
        RING_ATTR,
        STYLE_ID,
        HL_CSS,
        ANCHOR_ATTR,
        PILL_ATTR,
        region,
        label,
        HIT_TEXT_CHARS,
      ],
    })
    const out = res?.result as ({ found?: boolean } & RegionHit) | undefined
    if (!out?.found) {
      return {
        found: false,
        message:
          `No region [r${region}] on this page. Region numbers come from ReadPage(mode:"regions") and only ` +
          'survive until the page changes — re-run it and use a fresh number. If what you want to point at is ' +
          'a passage of words, it very likely has no region at all: highlight it with `text` instead.',
      }
    }
    hit = { tag: out.tag, name: out.name, text: out.text, width: out.width, height: out.height }
  } catch (err) {
    return {
      found: false,
      message: `Cannot highlight on this page (${err instanceof Error ? err.message : 'it may be a restricted page'}).`,
    }
  }
  await rememberTab(tabId)
  await syncPills(tabId)
  return { found: true, hit, message: describeRegionHit(region, hit) }
}

/**
 * Sweep highlights from every tab that has one. Called at the START of the next
 * fresh turn (Chat.tsx) — deliberately NOT in the turn's teardown `finally`,
 * unlike the presence overlay: highlights must outlive their turn so the user
 * can read what was marked.
 */
export async function clearAllHighlights(): Promise<void> {
  const ids = [...highlighted]
  highlighted.clear()
  await Promise.all(ids.map(clearTab))
  await forgetTabs(ids)
}

/**
 * Sweep highlights from the tabs of one window. Called by the SERVICE WORKER
 * when that window's side panel closes (background.ts, the panel port's
 * onDisconnect) — a highlight is chat-scoped feedback about an answer, so when
 * the chat goes away the mark on the page has to go with it. The panel cannot
 * do this itself: by the time it is closing, the context holding `highlighted`
 * is already being torn down, which is why the list is mirrored into
 * chrome.storage.session.
 *
 * Scoped by window because two windows can each have a panel open, and closing
 * one must not wipe the other's marks. Discarded tabs are skipped, not because
 * of cost but because injecting into one WAKES it (see the tabIndex invariant)
 * — and a discarded tab has already lost its DOM, so its highlight is gone.
 */
export async function sweepHighlightsForWindow(windowId: number): Promise<void> {
  let ids: number[] = []
  try {
    const got = await chrome.storage.session.get(SESSION_KEY)
    ids = Array.isArray(got[SESSION_KEY]) ? got[SESSION_KEY] : []
  } catch {
    return
  }
  if (ids.length === 0) return
  const mine: number[] = []
  await Promise.all(
    ids.map(async (id) => {
      try {
        const tab = await chrome.tabs.get(id)
        if (tab.windowId !== windowId) return
        mine.push(id)
        if (tab.discarded) return
        await clearTab(id)
      } catch {
        // The tab is gone — nothing to clear, but stop tracking it.
        mine.push(id)
      }
    }),
  )
  await forgetTabs(mine)
}
