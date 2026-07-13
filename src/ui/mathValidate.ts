// Deterministic LaTeX safety net. Runs before marked on a FINAL message: it
// KaTeX-trial-compiles every $…$ / $$…$$ span and neutralizes any that would
// not render (wrapping it as inert inline code) so a single malformed or stray
// `$` can never desync marked-katex's delimiter pairing and cascade-break the
// rest of the message. It also reports the broken spans (with offsets into the
// ORIGINAL text) so the surgical model-repair fallback can splice fixes back.
import katex from 'katex'

/** A delimited math span, addressed by its offsets into the original text. */
export interface MathSpan {
  raw: string
  start: number
  end: number
  display: boolean
}

/** `cleaned` is safe to hand to marked-katex (never desyncs); `invalid` lists
 *  the spans that would not compile, in document order. */
export interface MathValidation {
  cleaned: string
  invalid: MathSpan[]
}

// Alternatives, code FIRST (so a `$` inside code is consumed as code and never
// treated as math), then display `$$…$$` before inline `$…$`. The opening
// delimiters use a (?<!\\) lookbehind so a literal `\$` is never opened as math.
// Mirrors the code-awareness of mathDelimiters.ts.
const SCAN =
  /```[\s\S]*?```|~~~[\s\S]*?~~~|```[\s\S]*$|~~~[\s\S]*$|(`+)[\s\S]*?\1|(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\$((?:\\\$|[^$])+?)\$/g

function compiles(tex: string, display: boolean): boolean {
  try {
    katex.renderToString(tex, { throwOnError: true, displayMode: display })
    return true
  } catch {
    return false
  }
}

// Wrap a bad span so marked renders it inert (monospace), never as math. LaTeX
// virtually never contains a backtick; if it does, fall back to escaping the $
// so it shows as literal text instead of breaking the code span.
function neutralize(raw: string): string {
  if (raw.includes('`')) return raw.replace(/\$/g, '\\$')
  return '`' + raw + '`'
}

// Escape any unpaired `$` left in a plain-text segment so marked-katex cannot
// pair it across the gap. A literal `\$` is left alone.
function escapeStrayDollars(segment: string): string {
  return segment.replace(/(?<!\\)\$/g, '\\$')
}

// A `$$…$$` block only tokenizes when marked sees it as its own block — i.e.
// blank-line-separated. Models routinely glue it to the previous prose line with
// a single newline (`intro:\n$$…$$`), which folds it into the paragraph and
// leaves it rendered as raw source. Emitting a valid display span blank-line-
// isolated makes marked's block rule fire. Inline `$…$` is untouched, and any
// redundant blank lines collapse harmlessly.
function isolateDisplay(match: string): string {
  return `\n\n${match}\n\n`
}

/** Validate + neutralize the math in `text`. Pure; safe to run on every render. */
export function validateMath(text: string): MathValidation {
  const invalid: MathSpan[] = []
  let cleaned = ''
  let last = 0
  SCAN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SCAN.exec(text)) !== null) {
    const match = m[0]
    const display = m[2]
    const inline = m[3]
    cleaned += escapeStrayDollars(text.slice(last, m.index))
    const start = m.index
    const end = m.index + match.length
    last = end
    if (display !== undefined) {
      if (compiles(display.trim(), true)) cleaned += isolateDisplay(match)
      else {
        cleaned += neutralize(match)
        invalid.push({ raw: match, start, end, display: true })
      }
    } else if (inline !== undefined) {
      if (compiles(inline.trim(), false)) cleaned += match
      else {
        cleaned += neutralize(match)
        invalid.push({ raw: match, start, end, display: false })
      }
    } else {
      cleaned += match // code region — passthrough
    }
  }
  cleaned += escapeStrayDollars(text.slice(last))
  return { cleaned, invalid }
}
