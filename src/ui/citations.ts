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

const BRACKET_RE = /\[\[(\d{1,3})\]\]/g
const SENTINEL_RE = new RegExp(`${CITE_OPEN}(\\d{1,3})${CITE_CLOSE}`, 'g')

/** `[[n]]` -> private-use sentinel, applied BEFORE marked so markdown can't touch it. */
export function encodeCitations(text: string): string {
  return text.replace(BRACKET_RE, (_m, n) => `${CITE_OPEN}${n}${CITE_CLOSE}`)
}

/** Replace each surviving sentinel with `render(n)`'s output (applied AFTER sanitize). */
export function replaceCitationSentinels(html: string, render: (n: number) => string): string {
  return html.replace(SENTINEL_RE, (_m, d) => render(Number(d)))
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
