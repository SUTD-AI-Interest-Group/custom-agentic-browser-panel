// Visible text of the current viewport, for the decider's `page_text` state field.

/**
 * Runs inside the page. Self-contained: no outer-scope references.
 *
 * Text from separate block boxes is joined with " | "; inline siblings (a link and the price
 * beside it) keep a single space. A plain space join ran rows together — "Arc wireless
 * headphones — $64 Nimbus wireless headphones — $95" — and the decider then paired a price with
 * the wrong product (p 0.96, diag 2026-11-22). The block of a text node is its nearest ancestor
 * whose computed display is neither `inline` nor `contents`.
 */
function injViewportText(cap: number): string {
  const SEP = ' | '
  const vw = window.innerWidth
  const vh = window.innerHeight
  const parts: string[] = []
  let len = 0
  let lastBlock: Element | null = null
  const blockOf = (el: Element): Element => {
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const d = getComputedStyle(e).display
      if (d !== 'inline' && d !== 'contents') return e
    }
    return document.body
  }
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT)
  let n: Node | null
  while ((n = walker.nextNode()) && len < cap) {
    const t = (n.nodeValue ?? '').replace(/\s+/g, ' ').trim()
    if (!t) continue
    const p = n.parentElement
    if (!p) continue
    const tag = p.tagName
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue
    const cs = getComputedStyle(p)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const range = document.createRange()
    range.selectNodeContents(n)
    const r = range.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue
    const b = blockOf(p)
    if (parts.length) parts.push(b === lastBlock ? ' ' : SEP)
    lastBlock = b
    parts.push(t)
    len += t.length + 1
  }
  return parts.join('').slice(0, cap)
}

export async function readViewportText(tabId: number, cap: number): Promise<string> {
  const res = await chrome.scripting.executeScript({ target: { tabId }, func: injViewportText, args: [cap] })
  const out = res[0]?.result
  return typeof out === 'string' ? out : ''
}
