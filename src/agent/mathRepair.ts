// Surgical, silent LaTeX self-correction. When the deterministic validator
// (validateMath) cannot compile a math span, these helpers ask the model to fix
// ONLY the broken fragments and splice the corrected LaTeX back into the message
// — no answer content is regenerated. Every failure mode degrades to a no-op.
import { validateMath, type MathSpan } from '../ui/mathValidate'

/** A thin model call: prompt in, completion text out. Injected so this module
 *  stays pure/testable and unaware of the provider adapter. */
export type Complete = (prompt: string) => Promise<string>

/** Build the correction prompt for a set of broken fragments. */
export function buildRepairPrompt(spans: MathSpan[]): string {
  const list = spans.map((s, i) => `${i + 1}. ${s.raw}`).join('\n')
  return [
    'The following LaTeX math expressions from an assistant message are INVALID and will not render.',
    'Return corrected, valid LaTeX for each, keeping the same delimiters ($…$ for inline, $$…$$ for display).',
    'Fix only the LaTeX syntax — do not change the mathematical meaning, add commentary, or reorder.',
    'Respond with ONLY a JSON array, one object per item, in order:',
    '[{"index": 1, "fixed": "$$...$$"}]',
    '',
    'Expressions:',
    list,
  ].join('\n')
}

/** True iff `f` is exactly one `$…$` or `$$…$$` span (no surrounding text, no
 *  extra delimiters) that compiles clean. Guards the repair against a model
 *  reply that dropped its delimiters and would otherwise splice raw LaTeX into
 *  prose — turning safe inert-code back into a leak. */
function isWholeMathSpan(f: string): boolean {
  const display = f.startsWith('$$') && f.endsWith('$$') && f.length > 4
  const inline = !display && f.startsWith('$') && f.endsWith('$') && f.length > 2
  if (!display && !inline) return false
  const inner = display ? f.slice(2, -2) : f.slice(1, -1)
  if (!inner.trim() || inner.includes('$')) return false
  return validateMath(f).invalid.length === 0
}

/** Parse the model's JSON reply into a map of originalRaw → fixedLatex, keeping
 *  only fixes that themselves compile clean. Any malformed output ⇒ empty map. */
export function parseFixes(raw: string, spans: MathSpan[]): Map<string, string> {
  const out = new Map<string, string>()
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return out
  let arr: unknown
  try {
    arr = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return out
  }
  if (!Array.isArray(arr)) return out
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const idx = (item as { index?: unknown }).index
    const fixed = (item as { fixed?: unknown }).fixed
    if (typeof idx !== 'number' || typeof fixed !== 'string') continue
    const span = spans[idx - 1]
    if (!span) continue
    const f = fixed.trim()
    if (!isWholeMathSpan(f)) continue // accept only a single, delimited, clean span
    out.set(span.raw, f)
  }
  return out
}

/** Splice fixes into `text` at each span's recorded offsets, right-to-left so
 *  earlier offsets remain valid as later spans are replaced. */
export function spliceFixes(
  text: string,
  spans: MathSpan[],
  fixes: Map<string, string>,
): string {
  const ordered = [...spans].sort((a, b) => b.start - a.start)
  let out = text
  for (const s of ordered) {
    const fix = fixes.get(s.raw)
    if (fix === undefined) continue
    out = out.slice(0, s.start) + fix + out.slice(s.end)
  }
  return out
}

/** Validate `text`; if any math won't compile, ask `complete` to fix just those
 *  fragments and splice the corrected LaTeX back. Returns the original text on
 *  any failure or when the splice would not reduce the number of broken spans —
 *  so it can only ever improve the message, never regress it, and never throws. */
export async function repairMessageText(text: string, complete: Complete): Promise<string> {
  const { invalid } = validateMath(text)
  if (invalid.length === 0) return text
  let reply: string
  try {
    reply = await complete(buildRepairPrompt(invalid))
  } catch {
    return text
  }
  const fixes = parseFixes(reply, invalid)
  if (fixes.size === 0) return text
  const spliced = spliceFixes(text, invalid, fixes)
  return validateMath(spliced).invalid.length < invalid.length ? spliced : text
}
