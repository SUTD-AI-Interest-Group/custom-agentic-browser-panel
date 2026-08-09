// Pure parsing/normalization for the research framing call. Kept free of any
// Chrome or AI-SDK import so it can be unit-tested directly — same split as
// title.ts (pure) vs provider.ts (the call).

/** The framing call's normalized output, and the body of a `ResearchProposal`. */
export interface ResearchFramingResult {
  /** The question that will actually be researched. */
  question: string
  /** What the conversation already established, prepended to the Scope & Plan phase. */
  brief?: string
  /** Seed coverage for the notebook. */
  subQuestions: string[]
  /** Source scope as registrable hosts. Empty means unrestricted. */
  sites: string[]
  /** Raised when the user's message asserted something the context contradicts. */
  premise?: { asserted: string; corrected: string }
  /** At most two, and never blocking. */
  clarifications?: string[]
}

/**
 * A URL or bare host reduced to the registrable host we scope on: scheme, path,
 * port and a leading `www.` are dropped. Returns null when there is nothing
 * host-shaped to keep, so callers can filter rather than store empty strings.
 */
export function normalizeHost(input: string): string | null {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null
  // URL() needs a scheme; a bare host gets a throwaway one.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  let host: string
  try {
    host = new URL(withScheme).hostname
  } catch {
    return null
  }
  const bare = host.startsWith('www.') ? host.slice(4) : host
  return bare || null
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []

/**
 * Normalize the framing call's output into a `ResearchFramingResult`.
 *
 * Accepts either the object `generateObject` returns or the raw text of the
 * `generateText` fallback, because not every OpenAI-compatible endpoint honours
 * structured output. The string path is defensive in the same ways sanitizeTitle
 * is — an inline `<think>` block and a conversational preamble both appear ahead
 * of the JSON on real endpoints.
 *
 * Never throws: anything unusable degrades to `fallbackQuestion` with no premise
 * and no scope, because a blocked launch is worse than an unframed one.
 */
export function parseFraming(raw: string | object, fallbackQuestion: string): ResearchFramingResult {
  const bare: ResearchFramingResult = { question: fallbackQuestion, subQuestions: [], sites: [] }
  let obj: Record<string, unknown> | null = null
  if (typeof raw === 'string') {
    const thoughtless = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '')
    // The preamble ("Sure! Here you go:") is why we scan for the first brace
    // rather than parsing the whole string.
    const start = thoughtless.indexOf('{')
    const end = thoughtless.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        obj = JSON.parse(thoughtless.slice(start, end + 1))
      } catch {
        obj = null
      }
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>
  }
  if (!obj) return bare

  const question =
    typeof obj.question === 'string' ? obj.question.replace(/^["'“”]+|["'“”.]+$/g, '').trim() : ''
  if (!question) return bare

  const out: ResearchFramingResult = {
    question,
    subQuestions: strings(obj.subQuestions),
    sites: [...new Set(strings(obj.sites).map(normalizeHost).filter((h): h is string => h !== null))],
  }
  const brief = typeof obj.brief === 'string' ? obj.brief.trim() : ''
  if (brief) out.brief = brief
  const p = obj.premise as { asserted?: unknown; corrected?: unknown } | undefined
  // Half a premise flag is worse than none — it would render an accusation with
  // no correction beside it.
  if (p && typeof p.asserted === 'string' && typeof p.corrected === 'string') {
    out.premise = { asserted: p.asserted, corrected: p.corrected }
  }
  const clarifications = strings(obj.clarifications).slice(0, 2)
  if (clarifications.length) out.clarifications = clarifications
  return out
}
