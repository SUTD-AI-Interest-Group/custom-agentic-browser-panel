// Visible text of the current viewport, for the decider's `page_text` state field.

/** Runs inside the page. Self-contained: no outer-scope references. */
function injViewportText(cap: number): string {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const parts: string[] = []
  let len = 0
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
    parts.push(t)
    len += t.length + 1
  }
  return parts.join(' ').slice(0, cap)
}

export async function readViewportText(tabId: number, cap: number): Promise<string> {
  const res = await chrome.scripting.executeScript({ target: { tabId }, func: injViewportText, args: [cap] })
  const out = res[0]?.result
  return typeof out === 'string' ? out : ''
}
