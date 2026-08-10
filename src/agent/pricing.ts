// Local cost estimation for a turn's token usage.
//
// `usage.ts` deliberately leaves pricing to Langfuse, which prices a generation
// from its own model table. That is the right call for an exporter — but
// observability is an off-by-default beta, so on a normal install the token
// figures this app already collects have no way to become a number the user
// recognises. This module is the local half: rates the user enters per model
// (Settings → Providers), applied to the usage the provider actually reported.
//
// Rates live per model rather than shipped as a table because Lychee is
// model-agnostic by design: it talks to OpenAI, Anthropic, OpenRouter, Groq and
// anything OpenAI-compatible including local runtimes. A bundled price list
// would be wrong for custom endpoints on day one and silently stale for the
// rest within a quarter — and a confidently wrong cost is worse than no cost.
//
// Pure and dependency-free (only a type-only import), so it unit-tests without
// Chrome or the AI SDK.

import type { ModelUsage } from './observability'

/**
 * Per-model rates in **dollars per million tokens** — the unit every provider
 * publishes, so the user can copy a figure off a pricing page without doing
 * arithmetic first.
 *
 * Every field is optional and independent: a user who fills in only the output
 * rate still gets a partial figure rather than nothing. A rate of `0` is a
 * *real* price (a free local endpoint), which is why the settings UI clears a
 * blank input instead of writing `0` — the two must not collapse into one
 * value.
 */
export interface ModelPrice {
  inputPerMTok?: number
  outputPerMTok?: number
  /** Rate for tokens served from the provider's prompt cache; typically ~10% of
   *  the input rate. See `estimateCost` for why this is not simply additive. */
  cachedInputPerMTok?: number
}

const PER_MILLION = 1_000_000

/**
 * Estimate what one usage record cost, in dollars.
 *
 * Two pieces of arithmetic here are easy to get wrong, and both overstate:
 *
 * 1. **Cached tokens are carved out of `inputTokens`, not added to it.** Every
 *    provider that reports a cache-read figure counts those tokens inside the
 *    input total as well, so billing `inputTokens` at the full input rate *and*
 *    `cachedInputTokens` at the cache rate charges the cached half twice. A
 *    fully-cached prompt should cost the cache rate alone — on typical rates
 *    that is an 11x difference, which is exactly the kind of error that makes a
 *    cost display worse than none.
 *
 * 2. **Reasoning tokens are never billed separately.** `reasoningTokens` is a
 *    breakdown *of* `outputTokens`, not an addition to it. It is worth showing
 *    the user (it explains a surprising output count) but adding it to the bill
 *    double-charges every reasoning model.
 *
 * Returns `undefined` when nothing could be priced — no rate configured, or no
 * tokens to price. That is deliberately distinct from `0`: "no price set" and
 * "this turn was free" are different facts, and rendering the first as `$0.00`
 * tells the user their paid API calls cost nothing.
 */
export function estimateCost(usage: ModelUsage, price: ModelPrice): number | undefined {
  const input = usage.inputTokens ?? 0
  const reportedCached = usage.cachedInputTokens ?? 0
  // Cached tokens are by definition a subset of the input tokens. A provider
  // reporting more cached than input is inconsistent, so cap rather than let
  // the uncached term go negative and refund the user for reading a cache.
  const cached = usage.inputTokens === undefined ? reportedCached : Math.min(reportedCached, input)
  const uncached = Math.max(0, input - cached)
  const output = usage.outputTokens ?? 0

  let total = 0
  let priced = false
  // A term counts only when its rate is *defined* and it has tokens to bill.
  // Checking `!== undefined` rather than truthiness is what keeps a genuine
  // zero rate (a free local model) from reading as an absent one.
  if (price.inputPerMTok !== undefined && uncached > 0) {
    total += (uncached * price.inputPerMTok) / PER_MILLION
    priced = true
  }
  if (price.cachedInputPerMTok !== undefined && cached > 0) {
    total += (cached * price.cachedInputPerMTok) / PER_MILLION
    priced = true
  }
  if (price.outputPerMTok !== undefined && output > 0) {
    total += (output * price.outputPerMTok) / PER_MILLION
    priced = true
  }
  // Cached tokens with no cached rate stay unpriced rather than falling back to
  // the input rate: the fallback would overstate by roughly 10x on exactly the
  // turns prompt caching was meant to make cheap.
  return priced ? total : undefined
}

/** Drop a trailing `.0` so a round number reads as `2k`, not `2.0k`. */
function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '')
}

/**
 * Abbreviate a token count for a chip that has to fit beside a reply at panel
 * width. Exact below 1,000 — small counts are the ones worth reading precisely.
 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < PER_MILLION) return `${trim(n / 1000)}k`
  return `${trim(n / PER_MILLION)}M`
}

/**
 * Render a cost. Sub-cent turns collapse to `<$0.01` rather than `$0.00`: at
 * two decimal places most single turns round to zero, and a column of `$0.00`
 * reads as "this is free" instead of "this is cheap". An exact zero is shown as
 * `$0.00`, because a genuinely free model *is* free.
 */
export function formatCost(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}
