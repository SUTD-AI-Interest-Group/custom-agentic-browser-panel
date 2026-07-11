// Token accounting shared by the side-panel display and the Langfuse exporter.
// Kept separate from `observability/` on purpose: token/cost tracking works even
// when observability is off.

import type { ModelPrice } from '../data/settings'
import type { ModelUsage } from './observability'

/** Cost of one generation, in USD, split the way Langfuse's costDetails expects. */
export interface TokenCost {
  input: number
  output: number
  total: number
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

/** USD cost of a usage at a model's price. Undefined when the model has no price. */
export function computeCost(usage?: ModelUsage, price?: ModelPrice): TokenCost | undefined {
  if (!usage || !price) return undefined
  const input = ((usage.inputTokens ?? 0) / 1_000_000) * price.inputPer1M
  const output = ((usage.outputTokens ?? 0) / 1_000_000) * price.outputPer1M
  if (!input && !output) return undefined
  return { input, output, total: input + output }
}

/** 1240 → "1,240"; 16_200 → "16.2k". Keeps the inline token line short. */
export function formatTokens(n: number): string {
  if (n < 10_000) return n.toLocaleString('en-US')
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

/** Small costs need more precision than a plain currency format gives. */
export function formatUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}
