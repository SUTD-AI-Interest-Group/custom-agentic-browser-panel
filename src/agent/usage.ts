// Token accounting shared by the side-panel display and the Langfuse exporter.
// Kept separate from `observability/` on purpose: the token count under a reply
// works even when observability is off.
//
// Cost lives in Langfuse, not here: it prices a generation from its own model
// table, so the extension's job is to report accurate tokens and let Langfuse do
// the pricing (register custom/local model prices there if you want a figure).

import type { LanguageModelUsage } from 'ai'
import type { ModelUsage } from './observability'

/**
 * Converts the AI SDK's raw per-call usage (`LanguageModelUsage`) into this
 * app's flat `ModelUsage`. Not a no-op cast: the raw shape nests its cache
 * figures under `inputTokenDetails.cacheReadTokens`/`cacheWriteTokens` and its
 * reasoning figure under `outputTokenDetails.reasoningTokens` — every field on
 * `ModelUsage` is optional, so assigning a `LanguageModelUsage` straight into a
 * `ModelUsage`-typed variable (what `runAgentTurn` used to do) type-checks fine
 * while silently leaving `cachedInputTokens`/`reasoningTokens` `undefined`
 * forever, since the source object has no top-level field by either name. That
 * meant the prompt-cache breakpoint in `provider.ts`'s `withCacheControl`
 * could be genuinely hit and nothing downstream would ever show a nonzero
 * figure — not the Langfuse `cache_read` mapping in `observer.ts` (which
 * already reads `u.cachedInputTokens`), not any future UI surface. This is the
 * one conversion point both `runAgentTurn`'s per-step and turn-total usage
 * go through, so fixing it here lights up every existing consumer at once.
 * `cacheWriteTokens` has no home on `ModelUsage` (types.ts is not owned by
 * this file) — `runAgentTurn`'s per-step debug log reads it directly off the
 * raw usage instead of through this conversion.
 */
export function toModelUsage(u?: LanguageModelUsage): ModelUsage | undefined {
  if (!u) return undefined
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
    reasoningTokens: u.outputTokenDetails?.reasoningTokens,
    cachedInputTokens: u.inputTokenDetails?.cacheReadTokens,
  }
}

/**
 * Add two usages. Used to roll a continuation chain's cycles into one turn total,
 * and every turn into a conversation total. Returns undefined only when BOTH sides
 * are absent, so a chain whose first cycle reported nothing still totals correctly.
 */
export function sumUsage(a?: ModelUsage, b?: ModelUsage): ModelUsage | undefined {
  if (!a) return b
  if (!b) return a
  const add = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0)
  return {
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    totalTokens: add(a.totalTokens, b.totalTokens),
    reasoningTokens: add(a.reasoningTokens, b.reasoningTokens),
    cachedInputTokens: add(a.cachedInputTokens, b.cachedInputTokens),
  }
}

/** True when a usage carries any real number (an all-undefined usage renders nothing). */
export function hasTokens(u?: ModelUsage): boolean {
  if (!u) return false
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.totalTokens ?? 0) > 0
}

/** Total tokens, falling back to input+output when the endpoint omits a total. */
export function totalTokens(u?: ModelUsage): number {
  if (!u) return 0
  return u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
}

/** 1240 → "1,240"; 16_200 → "16.2k". Keeps the inline token line short. */
export function formatTokens(n: number): string {
  if (n < 10_000) return n.toLocaleString('en-US')
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
}
