// Pure assembly of the per-chain system prompt from its constituent notes —
// no Chrome, no React, no AI SDK. Extracted from runTurnChain (Chat.tsx) so
// the split below is independently testable.
//
// Anthropic's prompt cache matches a marked block byte-for-byte, with NO
// partial credit inside it — so concatenating everything into ONE string
// and marking that one string (which is all a plain reorder can do: see
// git history on this file) buys nothing on its own. Any change ANYWHERE in
// the string — including in content that changes every turn — misses the
// whole cached unit and pays a fresh write instead of a cheap read. The
// property that actually matters is a byte-identical STABLE prefix that
// `runAgentTurn`/`provider.ts`'s `withCacheControl` can mark as its own
// block, separate from a VOLATILE suffix that is free to change every turn
// without touching the marked bytes at all. `splitSystemPrompt` is what
// produces that split; `assembleSystemPrompt` (stable+volatile concatenated)
// exists for callers that want the flat legacy string.
//
//   STABLE  (near-identical across turns, often across whole conversations —
//            settings.systemPrompt and the skills catalog change only when
//            the user edits settings or installs/removes a skill):
//              systemPrompt, toolDisclosureNote, accessNote,
//              browsingInsightsNote, mathFormattingNote, skillsCatalog
//   VOLATILE (recomputed and generally different every turn):
//              memoryContext, activeSkills, retryNote
//
// Splitting is a pure REORDER-then-CUT of the terms the caller already
// assembled — no note's own text changes, and each one still carries its own
// leading blank line (`\n\n`) except memoryContext, which is wrapped with one
// here exactly as the pre-extraction code did. So `stable + volatile` is the
// same set of substrings as before, just cut at the point where cache
// placement actually needs it.
export interface SystemPromptParts {
  /** The user's own, editable system prompt (settings.systemPrompt). */
  systemPrompt: string
  /** Progressive-disclosure protocol note (TOOL_DISCLOSURE_NOTE). */
  toolDisclosureNote: string
  /** Set when tabAccess is restricted to the active tab; '' otherwise. */
  accessNote: string
  /** QueryBrowserData sources note for this turn. */
  browsingInsightsNote: string
  /** LaTeX formatting instructions (MATH_FORMATTING_NOTE). */
  mathFormattingNote: string
  /** The installed-skills catalog, or '' when none are model-invocable. */
  skillsCatalog: string
  /** Recalled long-term memories for this turn, or '' when the store is empty.
   *  Unlike the other parts, this one has NO leading blank line of its own —
   *  wrapped with one here, matching the pre-extraction call site. */
  memoryContext: string
  /** The user-invoked skill's full body, or '' when none was invoked. */
  activeSkills: string
  /** A regenerated turn's note about the discarded attempt, or ''. */
  retryNote: string
}

export interface SplitSystemPrompt {
  /** Near-constant across turns and conversations — see the module doc. */
  stable: string
  /** Recomputed every turn — never marked as a cache breakpoint. */
  volatile: string
}

/**
 * Splits the assembled prompt at the stable/volatile boundary. Pass this
 * directly as `runAgentTurn`'s `system` option — `provider.ts`'s Anthropic-
 * only `withCacheControl` middleware reads it and marks ONLY `stable` as a
 * cache breakpoint; every other provider (and Anthropic when
 * `withCacheControl` isn't wired in) just sees `stable + volatile`
 * concatenated into one ordinary system string, same as `assembleSystemPrompt`.
 */
export function splitSystemPrompt(parts: SystemPromptParts): SplitSystemPrompt {
  const stable =
    parts.systemPrompt +
    parts.toolDisclosureNote +
    parts.accessNote +
    parts.browsingInsightsNote +
    parts.mathFormattingNote +
    parts.skillsCatalog
  const volatile = (parts.memoryContext ? `\n\n${parts.memoryContext}` : '') + parts.activeSkills + parts.retryNote
  return { stable, volatile }
}

/** The flat concatenation — `stable + volatile`, byte-identical to what the
 *  pre-split code produced. Kept for callers/tests that want the single
 *  legacy string rather than the split object. */
export function assembleSystemPrompt(parts: SystemPromptParts): string {
  const { stable, volatile } = splitSystemPrompt(parts)
  return stable + volatile
}
