/**
 * What the on-device decision model is allowed to do. Each mode includes the one before it:
 * `shadow` records what it would have done at every page-control step, `assist` also maps forms
 * (AutofillForm without `fields`), and `driver` also takes page steps itself (FastSteps).
 */
export type DeciderMode = 'off' | 'shadow' | 'assist' | 'driver'
export interface DeciderSettings {
  mode: DeciderMode
  actThreshold?: number
}

/** Assist's form mapping runs in this mode: assist, and driver, which includes it. */
export const assistsForms = (m: DeciderMode | undefined): boolean => m === 'assist' || m === 'driver'

export const DEFAULT_ACT_THRESHOLD = 0.6
/**
 * How many previous actions the decider is shown. Ten, not six: an eight-step form dropped its
 * first fields out of a six-wide window, and the decider re-picked them (diag 2026-11-22).
 */
export const PREVIOUS_ACTIONS_WINDOW = 10
export const PAGE_TEXT_CAP = 1200
export const MODEL_ID = 'strands-decider-E2B-gemma4-v2-2611'
export const MODEL_STATUS_KEY = 'deciderModel'

const MODES: ReadonlySet<unknown> = new Set<DeciderMode>(['off', 'shadow', 'assist', 'driver'])

export function normalizeDecider(raw: unknown): DeciderSettings | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (!MODES.has(r.mode)) return undefined
  const out: DeciderSettings = { mode: r.mode as DeciderMode }
  const t = r.actThreshold
  if (typeof t === 'number' && Number.isFinite(t) && t >= 0.4 && t <= 0.95) out.actThreshold = t
  return out
}

/**
 * The decider settings for one chat run. A `@driver` message is a per-message opt-in to Driver:
 * for that run the mode reads `driver` whatever Shadow/Assist the settings say (Mode governs the
 * automatic behaviour; the token is the user asking for it this once). Off — or no decider
 * settings at all — still means off. Both realms apply this, the panel to the schemas the model
 * sees and the service worker (toolHost.ts, from `ChatRun.driver`) to the tools that execute, so
 * the two ToolSets agree. Pure.
 */
export function withDriverOverride(s: DeciderSettings | undefined, driver: boolean): DeciderSettings | undefined {
  if (!driver || !s || s.mode === 'off') return s
  return { ...s, mode: 'driver' }
}

/** Hard cap on a packed pass: at the model's 32768 the worker would allocate ~1.4 GB. */
export const DECIDER_MAX_TOKENS = 8192

/**
 * Driver mode's dense-page cap (spec §7.3): a next-action pass longer than this hands the page back
 * to the chat model instead of deciding slowly — 2.9 s at 4,920 tokens in the spike, and the dense
 * catalog (≈ 3,540 tokens) took 1.5–3.0 s in the harness runs.
 */
export const DRIVER_MAX_TOKENS = 2500

/**
 * The same cap for a `@driver` run (the user sent the message to the decider, so there is no chat
 * model to hand a dense page back to): 6000, still under DECIDER_MAX_TOKENS. FastSteps asks for it
 * per decision (`decider.next({ maxTokens })`); a chat-model FastSteps keeps DRIVER_MAX_TOKENS.
 */
export const DRIVER_RUN_MAX_TOKENS = 6000

/**
 * The longest pass the worker will run: the model's own limit, the hard cap above, and — when the
 * caller asks for less (driver mode's dense cap) — the caller's. A `maxTokens` that is not a
 * positive integer is ignored rather than trusted.
 */
export function tokenCap(maxLength: number, maxTokens?: number): number {
  const asked = typeof maxTokens === 'number' && Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : Infinity
  return Math.min(maxLength, DECIDER_MAX_TOKENS, asked)
}
