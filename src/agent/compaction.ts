// Folding the old half of a conversation into a summary, so a long chat stops
// short of its model's context window instead of dying at it.
//
// Without this, a long conversation eventually 400s with
// `context_length_exceeded`, and `classifyError` correctly files a 400 as
// PERMANENT (retrying sends the byte-identical request) — so the turn dies with
// no recovery and the user's only option is to start a new chat and lose their
// context by hand.
//
// This module is the pure half: it decides WHERE to cut and how to stitch the
// result back together. It never calls a model — `summarizeSpan.ts` does that,
// and hands the text here. Keeping the decision pure is what makes the two
// invariants below testable, and they are the whole reason this file exists:
// a fold that gets either one wrong turns a working long chat into a hard
// protocol error, which is strictly worse than the problem it set out to fix.
//
// INVARIANT 1 — never split a tool call from its result. Providers reject a
// history containing an assistant `tool-call` whose `tool-result` is missing
// (and the reverse), so a naive `slice()` at an arbitrary index trades a
// context-length error for a 400 that no retry can fix.
//
// INVARIANT 2 — never emit consecutive same-role messages. The native Anthropic
// adapter rejects two user-role entries in a row, which is exactly what a
// summary injected as `user` in front of a tail that also starts with `user`
// would produce.
//
// Both are enforced structurally rather than by inspection: the cut only ever
// lands immediately before a user message (a real turn boundary, and the only
// place tool pairing is guaranteed already closed), and the replacement is
// always the fixed user/assistant pair `applyCompaction` builds.

import type { ModelMessage } from 'ai'

/** How many of the most recent user turns are never folded, by default. */
const DEFAULT_KEEP_RECENT_USER_TURNS = 4

/** Rough characters-per-token, used only by the fallback estimator. */
const CHARS_PER_TOKEN = 4

/**
 * A validated split of a history into the span to summarize and the span to
 * keep verbatim. `fold ++ keep` always equals the input, so nothing is lost or
 * duplicated.
 */
export interface CompactionPlan {
  /** The old span, to be replaced by a summary. */
  fold: ModelMessage[]
  /** The recent span, carried through untouched. */
  keep: ModelMessage[]
  /** Index in the original history where `keep` begins. */
  foldIndex: number
}

/** Every tool-call and tool-result id referenced by a message. */
function toolIdsOf(message: ModelMessage): { calls: string[]; results: string[] } {
  const calls: string[] = []
  const results: string[] = []
  if (Array.isArray(message.content)) {
    for (const part of message.content as Array<{ type: string; toolCallId?: string }>) {
      if (!part?.toolCallId) continue
      if (part.type === 'tool-call') calls.push(part.toolCallId)
      if (part.type === 'tool-result') results.push(part.toolCallId)
    }
  }
  return { calls, results }
}

/**
 * True when this span references a tool call without its result, or a result
 * without its call — i.e. cutting here would orphan half a pair.
 */
function isSelfContained(messages: ModelMessage[]): boolean {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const m of messages) {
    const ids = toolIdsOf(m)
    for (const id of ids.calls) calls.add(id)
    for (const id of ids.results) results.add(id)
  }
  for (const id of calls) if (!results.has(id)) return false
  for (const id of results) if (!calls.has(id)) return false
  return true
}

/**
 * Choose where to fold a history, or `null` when it should be left alone.
 *
 * `keepRecentUserTurns` is a **floor**, not a target: if the natural boundary
 * would orphan a tool pair, the cut moves *earlier* — folding less and keeping
 * more — never later. Keeping extra context is always safe; keeping less than
 * the caller asked for is not, and a boundary that walked forward could strand
 * the model mid-task with the very turns it was working from summarized away.
 * If no safe boundary exists at all, this declines by returning `null` rather
 * than returning a plan that would 400.
 */
export function planCompaction(
  history: ModelMessage[],
  opts?: { keepRecentUserTurns?: number },
): CompactionPlan | null {
  const keepRecent = opts?.keepRecentUserTurns ?? DEFAULT_KEEP_RECENT_USER_TURNS
  if (keepRecent <= 0) return null

  // Every candidate boundary is the index of a user message: that is a real
  // turn boundary, and the one position where a tool pair opened by the
  // previous turn is already guaranteed closed.
  const userIndices: number[] = []
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'user') userIndices.push(i)
  }
  // Nothing to fold: every user turn present is one the caller asked to keep.
  if (userIndices.length <= keepRecent) return null

  // The natural boundary keeps exactly `keepRecent` user turns. Walking
  // backwards from there folds progressively less, so the first safe candidate
  // is also the most compaction we can do without breaking a pair.
  const natural = userIndices.length - keepRecent
  for (let candidate = natural; candidate >= 1; candidate--) {
    const foldIndex = userIndices[candidate]
    const fold = history.slice(0, foldIndex)
    const keep = history.slice(foldIndex)
    if (fold.length === 0) continue
    if (isSelfContained(fold) && isSelfContained(keep)) return { fold, keep, foldIndex }
  }
  return null
}

/**
 * Stitch a summarized plan back into a history the model can be given.
 *
 * The replacement is deliberately a *pair* — the summary as a user message, then
 * a fixed assistant acknowledgement — rather than a single message. One message
 * would leave the role of `keep[0]` deciding whether the result alternates, and
 * `keep[0]` is always a user message by construction (see `planCompaction`), so
 * a lone user-role summary would produce exactly the consecutive-user sequence
 * the native Anthropic adapter rejects. The pair makes alternation structural
 * instead of incidental.
 *
 * `keep` is spliced in by reference and never rewritten, which is what lets
 * `lychee-attachment:<id>` sentinels in the tail survive compaction untouched.
 */
export function applyCompaction(plan: CompactionPlan, summary: string): ModelMessage[] {
  return [
    {
      role: 'user',
      content: `<conversation-summary>\nThis conversation is long, so its earlier turns have been condensed. Treat the following as an accurate record of what came before:\n\n${summary}\n</conversation-summary>`,
    },
    { role: 'assistant', content: 'Understood — continuing from that summary.' },
    ...plan.keep,
  ]
}

/**
 * A rough token count for a history, used only when the provider has not yet
 * reported real usage (the first turn of a restored conversation, or an endpoint
 * that reports none at all). Reported `inputTokens` is ground truth and is
 * always preferred — see the caller.
 *
 * Serializes each message rather than reading string content, because the
 * largest thing in a long history is almost always a tool result carrying a
 * page's text, and a string-only estimate would score those at zero — failing
 * to compact exactly the conversations that most need it.
 */
export function estimateHistoryTokens(history: ModelMessage[]): number {
  let chars = 0
  for (const m of history) {
    try {
      chars += JSON.stringify(m)?.length ?? 0
    } catch {
      // Non-serializable content is vanishingly rare and never worth throwing
      // over: fall back to a nominal size so the estimate stays monotonic.
      chars += 100
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}
