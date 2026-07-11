/**
 * Tolerant JSON parse for model output that may be fenced or wrapped in prose.
 * Strips ```json fences, then falls back to the outermost brace/bracket span.
 * Throws if nothing parses — callers treat that as an extraction failure.
 */
export function parseJsonLoose(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?/gi, '').trim()
  try {
    return JSON.parse(unfenced)
  } catch {}
  const start = unfenced.search(/[[{]/)
  const end = Math.max(unfenced.lastIndexOf('}'), unfenced.lastIndexOf(']'))
  if (start === -1 || end <= start) throw new Error('no JSON found in text')
  return JSON.parse(unfenced.slice(start, end + 1))
}
