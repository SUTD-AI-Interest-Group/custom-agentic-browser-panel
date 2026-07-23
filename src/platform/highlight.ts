// The "show me where" highlighter: scrolls the active tab to a passage or
// region and marks it like a highlighter pen. Distinct from presence.ts (the
// agent-is-acting overlay) in two deliberate ways: it is marker-yellow, not
// agent-blue, and it OUTLIVES the turn — the whole point is that the user reads
// the marked passage after the answer lands. Cleared at the next fresh turn
// (Chat.tsx), or by navigation wiping the page.
//
// Text passages use the CSS Custom Highlight API (a Range registered in
// CSS.highlights + one injected ::highlight rule), which tracks reflow/resize
// natively. Regions (charts/figures — a background color would be invisible)
// get a document-space ring in an overlay root instead.
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
// Bound the collect payload — beyond this the page is pathological.
const MAX_COLLECT_CHARS = 500_000

/** Tabs with a live highlight, so the next fresh turn can sweep them. */
const highlighted = new Set<number>()

interface ApplyPayload {
  startChunk: number
  startOffset: number
  endChunk: number
  endOffset: number
  label: string
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
    style.textContent = `::highlight(${hlName}){background-color:rgba(255,213,79,.55);color:inherit;}`
    document.head.appendChild(style)
  }

  range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  // Let the smooth scroll (and any lazy-load reflow it triggers) settle, then
  // read the LIVE rect for the pill/glow — document-space, so later scrolling
  // doesn't detach them from the text.
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
  if (p.label) {
    const pill = document.createElement('div')
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

// Region ring: re-find the region by its [rN] stamp, scroll, wait for the
// scroll/lazy-load to settle, then read the LIVE rect (the indexed rect is
// stale by then — see the regionIndex invariant) and ring it in document space.
async function injRegionHighlight(rootId: string, attr: string, region: number, label: string) {
  const el = document.querySelector(`[${attr}="${region}"]`)
  if (!el) return { found: false }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  await new Promise((r) => setTimeout(r, 700))
  const rect = el.getBoundingClientRect()
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
  const pad = 5
  const ring = document.createElement('div')
  ring.style.cssText =
    `position:absolute;left:${docX - pad}px;top:${docY - pad}px;width:${rect.width + pad * 2}px;` +
    `height:${rect.height + pad * 2}px;border:2.5px solid rgba(255,193,7,.95);border-radius:8px;` +
    'box-shadow:0 0 0 4px rgba(255,213,79,.28);pointer-events:none;'
  root.appendChild(ring)
  if (label) {
    const pill = document.createElement('div')
    pill.style.cssText =
      'position:absolute;padding:3px 8px;background:#ffd54f;color:#3d2e00;border-radius:6px;' +
      'font:600 12px system-ui;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25);' +
      `transform:translateY(-130%);left:${docX - pad}px;top:${docY - pad}px;`
    pill.textContent = label
    root.appendChild(pill)
  }
  ring.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: 'ease-out', fill: 'both' })
  return { found: true }
}

function injClear(rootId: string, styleId: string, hlName: string) {
  document.getElementById(rootId)?.remove()
  document.getElementById(styleId)?.remove()
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  registry?.delete(hlName)
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
      args: [ROOT_ID, STYLE_ID, HL_NAME, MAX_COLLECT_CHARS, 'collect', null],
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
    args: [ROOT_ID, STYLE_ID, HL_NAME, MAX_COLLECT_CHARS, 'apply', { ...m.first, label }],
  })
  if (!(applied?.result as { ok?: boolean } | undefined)?.ok) {
    return { found: false, count: m.count, message: 'Found the passage but could not mark it on this page.' }
  }
  highlighted.add(tabId)
  const many =
    m.count > 1
      ? ` It appears ${m.count} times; the first occurrence is marked — quote a longer stretch to pin a different one.`
      : ''
  return { found: true, count: m.count, message: `Scrolled to the passage and highlighted it for the user.${many}` }
}

/**
 * Ring one visual region ([rN] from ReadPage mode:"regions"): smooth-scroll to
 * it, then draw a document-space ring + optional label pill around its live rect.
 */
export async function highlightRegionOnPage(
  tabId: number,
  region: number,
  label = '',
): Promise<{ found: boolean; message: string }> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injRegionHighlight,
      args: [ROOT_ID, REGION_ATTR, region, label],
    })
    if (!(res?.result as { found?: boolean } | undefined)?.found) {
      return {
        found: false,
        message: `No region [r${region}] on this page — the page may have changed. Re-run ReadPage(mode:"regions") and use a fresh number.`,
      }
    }
  } catch (err) {
    return {
      found: false,
      message: `Cannot highlight on this page (${err instanceof Error ? err.message : 'it may be a restricted page'}).`,
    }
  }
  highlighted.add(tabId)
  return { found: true, message: `Scrolled to region [r${region}] and highlighted it for the user.` }
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
  await Promise.all(
    ids.map((id) =>
      chrome.scripting
        .executeScript({ target: { tabId: id }, func: injClear, args: [ROOT_ID, STYLE_ID, HL_NAME] })
        .catch(() => {}),
    ),
  )
}
