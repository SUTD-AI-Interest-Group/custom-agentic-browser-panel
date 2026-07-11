// Some models (notably OpenAI-family) emit LaTeX math as \(…\) / \[…\], but
// marked-katex-extension only tokenizes the $…$ / $$…$$ forms. Convert the
// backslash-delimited forms so they render too — but never inside code, or a
// code sample containing \( or \[ would be corrupted (including while a fenced
// block is still streaming and has not yet received its closing fence).
//
// We scan once with a single regex whose alternatives match a code region OR a
// math delimiter, code alternatives first. A matched code region is returned
// unchanged, so any \( / \[ inside it is consumed as part of the code and never
// rewritten. Code alternatives cover closed and unterminated ``` / ~~~ fences
// and backtick-balanced inline spans of any run length (`x`, ``x``, …).
//
// Caveat: an inline code span needs its *closing* backtick run to be
// recognized, so a not-yet-terminated inline span mid-stream can briefly
// convert a \( inside it. This self-heals the instant the closing backtick
// streams in — the final rendered text is always correct.
const CODE_OR_MATH =
  /```[\s\S]*?```|~~~[\s\S]*?~~~|```[\s\S]*$|~~~[\s\S]*$|(`+)[\s\S]*?\1|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g

/** Convert `\(…\)` → `$…$` and `\[…\]` → `$$…$$`, but never inside code. */
export function normalizeMathDelimiters(text: string): string {
  return text.replace(CODE_OR_MATH, (match, _backticks, display, inline) => {
    if (display !== undefined) return `$$${display}$$`
    if (inline !== undefined) return `$${inline}$`
    return match
  })
}
