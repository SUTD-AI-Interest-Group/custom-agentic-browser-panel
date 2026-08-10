// Condensing the old span of a conversation into prose the model can carry
// forward, for `compaction.ts` to splice back in.
//
// Split from compaction.ts on purpose: the *decision* of where to cut is pure
// and heavily invariant-tested, while this half makes a network call. Keeping
// them apart is what lets the dangerous logic be tested exhaustively without a
// model in the loop.
//
// The hard rule here is that compaction must never be the reason a turn fails.
// A turn reaches this code precisely when its history no longer fits — the
// worst possible moment to introduce a new way to throw. So every failure path
// falls back to a deterministic, model-free summary instead of propagating.

import { generateText, type LanguageModel, type ModelMessage } from 'ai'

/** A slow summarizer would stall the turn it is trying to rescue. */
const SUMMARIZE_TIMEOUT_MS = 30_000

/** Ceiling on the span text handed to the model, so the summarizer itself
 *  cannot overflow the very window it is being used to stay inside. */
const MAX_SPAN_CHARS = 60_000

/** How much of each end of the span the deterministic fallback preserves. */
const FALLBACK_EDGE_CHARS = 1500

const SUMMARIZE_PROMPT = `You are condensing the earlier part of a conversation so it can be carried forward in a smaller context window.

Write a factual summary in prose. Preserve, in order of importance:
- decisions made and conclusions reached, with the reasoning behind them
- concrete specifics: names, identifiers, file paths, URLs, numbers, versions, exact values
- the user's stated preferences, constraints and corrections
- anything still unfinished, and what the next step was going to be
- dead ends already ruled out, so they are not retried

Do not editorialise, do not add anything that was not said, and do not address the reader. If the span contains tool calls, record what they established rather than that they happened.`

/** One message rendered as a labelled line. Tool traffic is named but its
 *  payload is dropped: a page's full text is what made the span too big. */
function renderMessage(m: ModelMessage): string {
  const role = m.role === 'tool' ? 'Tool result' : m.role === 'user' ? 'User' : 'Assistant'
  if (typeof m.content === 'string') return `${role}: ${m.content}`
  if (!Array.isArray(m.content)) return ''
  const pieces: string[] = []
  for (const part of m.content as Array<Record<string, unknown>>) {
    if (part.type === 'text' && typeof part.text === 'string') pieces.push(part.text)
    else if (part.type === 'tool-call') pieces.push(`[called ${String(part.toolName)}]`)
    else if (part.type === 'tool-result') pieces.push(`[result from ${String(part.toolName)}]`)
    else if (part.type === 'file') pieces.push('[attachment]')
  }
  const body = pieces.join(' ').trim()
  return body ? `${role}: ${body}` : ''
}

/**
 * Render a span as plain transcript text for the summarizer. Trimmed from the
 * FRONT when over budget, so the turns nearest the surviving tail — the ones
 * most likely to still matter — are the ones that reach the model.
 */
export function renderSpan(messages: ModelMessage[]): string {
  const text = messages.map(renderMessage).filter(Boolean).join('\n\n')
  return text.length > MAX_SPAN_CHARS ? text.slice(text.length - MAX_SPAN_CHARS) : text
}

/**
 * A summary built without a model, for when the summarizer call fails.
 *
 * Keeps both ends of the span verbatim and says plainly that the middle is
 * missing. That honesty is the point: a silent truncation would let the model
 * answer as though it had the whole history, whereas a stated gap lets it say
 * it no longer has the detail — and lets the user see why.
 */
export function fallbackSummary(messages: ModelMessage[]): string {
  const text = messages.map(renderMessage).filter(Boolean).join('\n\n')
  if (text.length <= FALLBACK_EDGE_CHARS * 2) return text
  const head = text.slice(0, FALLBACK_EDGE_CHARS)
  const tail = text.slice(text.length - FALLBACK_EDGE_CHARS)
  return `${head}\n\n[…${messages.length} earlier messages could not be summarized automatically; the middle of this span is missing. Say so rather than guessing if asked about it…]\n\n${tail}`
}

/**
 * Summarize a span, degrading to `fallbackSummary` on any failure — a bad
 * endpoint, a timeout, an abort, or a model that returns nothing usable.
 * Never throws.
 */
export async function summarizeSpan(
  model: LanguageModel,
  messages: ModelMessage[],
): Promise<string> {
  if (messages.length === 0) return ''
  try {
    const { text } = await generateText({
      model,
      prompt: `${SUMMARIZE_PROMPT}\n\n--- CONVERSATION SPAN ---\n${renderSpan(messages)}`,
      abortSignal: AbortSignal.timeout(SUMMARIZE_TIMEOUT_MS),
    })
    const summary = text.trim()
    // An empty or near-empty reply is a failure wearing a success's clothes:
    // splicing it in would silently delete the span instead of condensing it.
    return summary.length >= 20 ? summary : fallbackSummary(messages)
  } catch {
    return fallbackSummary(messages)
  }
}
