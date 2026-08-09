// Parsing/normalization for the research framing call, plus the call itself.
// The parser (parseFraming/normalizeHost) is pure and Chrome/AI-SDK-free so it
// stays unit-testable directly — same split as title.ts (pure) vs provider.ts
// (the call).

import { generateObject, generateText, jsonSchema, type LanguageModel } from 'ai'

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
 * True for a normalized host with at least one dot — i.e. not a bare public
 * suffix like `com` or `net`. `scopeAllows` (browsePolicy.ts) matches by dotted
 * suffix (`host === s || host.endsWith('.' + s)`), so a dotless scope entry
 * would suffix-match every host on the internet under that TLD — a launch-card
 * chip the user reads as "pinned to one site" that in fact restricts nothing.
 * That is worse than no scope at all, because it misleads, so such entries are
 * dropped here rather than let through to become a scope entry.
 */
const isScopableHost = (host: string | null): host is string => host !== null && host.includes('.')

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
    sites: [...new Set(strings(obj.sites).map(normalizeHost).filter(isScopableHost))],
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

const FRAMING_TIMEOUT_MS = 20_000

const FRAMING_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The question to research, self-contained and specific.' },
    brief: { type: 'string', description: 'What the conversation already established that research should not re-derive.' },
    subQuestions: { type: 'array', items: { type: 'string' }, description: '2-5 sub-questions to cover.' },
    sites: { type: 'array', items: { type: 'string' }, description: 'Hosts to restrict sources to, when the conversation clearly implies them. Empty if not.' },
    premise: {
      type: 'object',
      properties: { asserted: { type: 'string' }, corrected: { type: 'string' } },
      description: 'ONLY when the user asserted something the context contradicts.',
    },
    clarifications: { type: 'array', items: { type: 'string' }, description: 'At most 2, only when genuinely ambiguous.' },
  },
  required: ['question'],
} as const

export interface FrameResearchOpts {
  model: LanguageModel
  /** The armed message verbatim — also the fallback question. */
  message: string
  /** Recent conversation, newest last, already trimmed by the caller. */
  context: string
  signal?: AbortSignal
}

const PROMPT = (message: string, context: string) =>
  `Turn the user's request into a background research brief.\n\n` +
  `CRITICAL: if the request asserts a fact the conversation contradicts (a count, a name, a date), ` +
  `use the CORRECTED fact in "question" AND report both halves in "premise". Never silently correct ` +
  `and never research a premise you know to be wrong.\n\n` +
  `Set "sites" only when the conversation clearly points at specific hosts. Ask a clarification only ` +
  `when you genuinely cannot proceed — at most two.\n\n` +
  `Conversation so far:\n${context}\n\nThe request: ${message}`

/**
 * One cheap call that turns an armed message into an editable proposal.
 * Deliberately NOT a runAgentTurn: no tool loop, no step budget, no way for it
 * to wander into the browser. Same shape as the chat-title call.
 *
 * Falls back generateObject → generateText → raw message, because structured
 * output is unreliable on some OpenAI-compatible endpoints and a failed framing
 * must degrade the card, never block the launch.
 *
 * NOTE on `signal`: when the caller doesn't supply one, the SAME AbortSignal.timeout
 * instance backs both the generateObject attempt and the generateText fallback below.
 * AbortSignal.timeout() fires (and latches aborted, permanently) at most once; if
 * that firing is *why* generateObject failed, the fallback's fetch sees an
 * already-aborted signal and rejects immediately without reaching the network —
 * so the fallback cannot help recover from a timeout specifically, only from a
 * fast non-timeout failure (e.g. a 400 for missing structured-output support,
 * this tier's primary reason for existing) that leaves time on the shared clock.
 * The three-tier degrade to the raw message still holds either way — see the
 * task report for the full analysis and why this wasn't restructured here.
 */
export async function frameResearch(opts: FrameResearchOpts): Promise<ResearchFramingResult> {
  const prompt = PROMPT(opts.message, opts.context)
  const signal = opts.signal ?? AbortSignal.timeout(FRAMING_TIMEOUT_MS)
  try {
    const { object } = await generateObject({
      model: opts.model,
      schema: jsonSchema(FRAMING_SCHEMA as any),
      prompt,
      abortSignal: signal,
    })
    return parseFraming(object as object, opts.message)
  } catch {
    try {
      const { text } = await generateText({
        model: opts.model,
        prompt: `${prompt}\n\nReply with JSON only.`,
        abortSignal: signal,
      })
      return parseFraming(text, opts.message)
    } catch {
      return { question: opts.message, subQuestions: [], sites: [] }
    }
  }
}
