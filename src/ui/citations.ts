// Inline citation handling for research reports. The synthesizer emits citations
// as a `[[n]]` sentinel (double bracket) — distinct from a literal `[1]` that may
// appear in quoted prose. At render time we swap each `[[n]]` for an inline
// favicon chip linking to source n; when copied as Markdown we degrade back to a
// portable `[n]`.
//
// These helpers are pure/Chrome-independent (unit-tested). The favicon <img>
// URL (chrome-extension://) would be stripped by DOMPurify, so the sentinel is
// carried through marked + sanitize using private-use code points that neither
// touches, then replaced afterwards — see Markdown.tsx.

/** Private-use delimiters that survive marked + DOMPurify untouched. */
export const CITE_OPEN = String.fromCharCode(0xe000)
export const CITE_CLOSE = String.fromCharCode(0xe001)

// Capped at 3 digits (max source index 999) — deliberate, not an oversight.
// A report with 1000+ sources is unrealistic; [[1000]] is simply left as raw,
// un-encoded markdown source rather than degrading to a plain [1000] fallback
// (F7, d12 — low real-world impact, documented rather than widened).
const BRACKET_RE = /\[\[(\d{1,3})\]\]/g
const SENTINEL_RE = new RegExp(`${CITE_OPEN}(\\d{1,3})${CITE_CLOSE}`, 'g')

// Code regions FIRST (passthrough, unmatched/uncaptured), citation pattern
// SECOND — mirrors mathDelimiters.ts's CODE_OR_MATH code-awareness. Without
// this, a `[[n]]` appearing inside a fenced block or inline code span (e.g. a
// report documenting its own citation syntax, or quoting a source that
// literally uses double-bracket wiki-style references) got linkified into a
// live favicon-chip <a> INSIDE a <code> element (F1, d12).
const CODE_OR_CITATION =
  /```[\s\S]*?```|~~~[\s\S]*?~~~|```[\s\S]*$|~~~[\s\S]*$|(`+)[\s\S]*?\1|\[\[(\d{1,3})\]\]/g

/** `[[n]]` -> private-use sentinel, applied BEFORE marked so markdown can't
 *  touch it. Never encodes a `[[n]]` that lands inside a fenced or inline code
 *  region — it survives as literal text there instead of becoming a live
 *  citation chip (F1, d12). */
export function encodeCitations(text: string): string {
  return text.replace(CODE_OR_CITATION, (match, _backticks, n) => {
    if (n !== undefined) return `${CITE_OPEN}${n}${CITE_CLOSE}`
    return match // code region — passthrough, [[n]] inside stays literal
  })
}

/** Replace each surviving sentinel with `render(n)`'s output (applied AFTER
 *  sanitize). Walks the DOM rather than doing a blind string-splice, so a
 *  sentinel that lands inside a code element (e.g. via raw HTML passthrough —
 *  defense in depth alongside encodeCitations' source-side guard) or inside an
 *  already-open <a> (a citation attached directly to linked text, e.g.
 *  `[TechCrunch[[1]]](url)`) never produces broken markup: inside
 *  <code>/<pre> the sentinel decodes back to plain `[[n]]` text instead of a
 *  live link; inside an existing <a> the chip renders without its own
 *  wrapping anchor, since an <a> can never legally nest inside another <a>
 *  (F2, d12 — a nested pair is malformed HTML the browser silently
 *  restructures/splits, unpredictably truncating the intended link). */
export function replaceCitationSentinels(html: string, render: (n: number) => string): string {
  if (!html.includes(CITE_OPEN)) return html // fast path: nothing to do
  const root = document.createElement('div')
  root.innerHTML = html
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n as Text).data.includes(CITE_OPEN)) targets.push(n as Text)
  }
  for (const node of targets) {
    const inCode = !!node.parentElement?.closest('code, pre')
    const inLink = !!node.parentElement?.closest('a')
    const out = node.data.replace(SENTINEL_RE, (_m, d) => {
      if (inCode) return `[[${d}]]`
      const chip = render(Number(d))
      return inLink ? unwrapAnchor(chip) : chip
    })
    const frag = document.createElement('span')
    frag.innerHTML = out
    node.replaceWith(...Array.from(frag.childNodes))
  }
  return root.innerHTML
}

/** Strip a chip's own wrapping `<a>` (used when the chip must render inside an
 *  already-open link). A plain `[n]` fallback has no wrapping element and
 *  passes through unchanged. */
function unwrapAnchor(chipHtml: string): string {
  const tmp = document.createElement('div')
  tmp.innerHTML = chipHtml
  const a = tmp.firstElementChild
  return a && a.tagName === 'A' ? a.innerHTML : chipHtml
}

/** `[[n]]` → `[n]`: the portable form used for copy-as-Markdown and text-only fallback. */
export function citationsToPlain(text: string): string {
  return text.replace(BRACKET_RE, (_m, n) => `[${n}]`)
}

/** Escape a string for safe interpolation into an HTML attribute value. */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
