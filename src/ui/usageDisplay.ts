// Turning a turn's token usage into the two strings the chat renders: the chip
// under a reply and the conversation total under the transcript.
//
// Pure and React-free (only a type-only UIMessage import), matching the
// file-per-pure-helper convention this directory already uses (chatNaming.ts,
// recentContext.ts, researchCard.ts, …) so it unit-tests without mounting Chat.

import type { UIMessage } from '../agent/agent'
import type { ModelUsage } from '../agent/observability'
import { sumUsage } from '../agent/usage'
import { estimateCost, formatCost, formatTokens, type ModelPrice } from '../agent/pricing'

/**
 * Total tokens across a whole transcript. Folds every message's `usage` through
 * the same `sumUsage` a continuation chain uses for its cycles, so a chain that
 * merged four cycles into one bubble and a chain that split them across four
 * bubbles total identically.
 *
 * Returns `undefined` when nothing reported usage — a streaming endpoint with
 * `includeUsage` off reports none at all, and a footer reading "0 tokens" would
 * claim a conversation was free rather than admitting it is unmeasured.
 */
export function conversationUsage(messages: UIMessage[]): ModelUsage | undefined {
  let total: ModelUsage | undefined
  for (const m of messages) {
    if (m.usage) total = sumUsage(total, m.usage)
  }
  return total
}

/** The strings a usage chip renders: a compact summary, an optional cost, and
 *  the fuller breakdown that rides in the `title` tooltip. */
export interface UsageLabel {
  /** e.g. `1.2k → 340`. */
  tokens: string
  /** e.g. `$0.004`. Absent when the model has no rates configured. */
  cost?: string
  /** Full breakdown for the tooltip, naming only the figures that exist. */
  detail: string
}

/**
 * Render one usage record for display.
 *
 * The tooltip names cached and reasoning tokens only when the provider actually
 * reported them: every provider omits at least one of these, and a tooltip
 * reading "0 cached" on an endpoint that has no prompt cache invites the reader
 * to conclude their caching is broken rather than absent.
 */
export function usageLabel(usage: ModelUsage, price: ModelPrice): UsageLabel {
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const parts = [`${formatTokens(input)} in`, `${formatTokens(output)} out`]
  if (usage.cachedInputTokens) parts.push(`${formatTokens(usage.cachedInputTokens)} cached`)
  if (usage.reasoningTokens) parts.push(`${formatTokens(usage.reasoningTokens)} reasoning`)
  const cost = estimateCost(usage, price)
  return {
    tokens: `${formatTokens(input)} → ${formatTokens(output)}`,
    cost: cost === undefined ? undefined : formatCost(cost),
    detail: parts.join(' · '),
  }
}
