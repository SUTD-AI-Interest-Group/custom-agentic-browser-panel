// Some models (notably OpenAI-family) emit LaTeX math as \(…\) / \[…\], but
// marked-katex-extension only tokenizes the $…$ / $$…$$ forms. Convert the
// backslash-delimited forms so they render too — but never inside code, or a
// code sample containing \( or \[ would be corrupted. We split the text on
// code spans/blocks (captured, so they land at odd indices) and rewrite only
// the non-code chunks.

/** Fenced blocks (``` or ~~~) and inline code spans — matched as one group so
 * String.prototype.split keeps them, interleaved at odd indices. */
const CODE_SPAN = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g

/** Convert `\(…\)` → `$…$` and `\[…\]` → `$$…$$` outside code. */
export function normalizeMathDelimiters(text: string): string {
  return text
    .split(CODE_SPAN)
    .map((chunk, i) => (i % 2 === 1 ? chunk : rewriteMath(chunk)))
    .join('')
}

function rewriteMath(s: string): string {
  return s
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body) => `$$${body}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body) => `$${body}$`)
}
