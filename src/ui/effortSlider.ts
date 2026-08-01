import type { ReasoningEffort } from '../data/settings'

/** Where the reasoning-effort slider sits: its rung index, and the fill percent. */
export interface EffortSliderState {
  index: number
  pct: number
}

/**
 * Resolve the model picker's effort slider from a model's rungs and its
 * currently-set effort. `current` absent from `levels` — a stale per-model
 * override left over after the provider profile changed, or one set while a
 * different model was selected — clamps to index 0 rather than crashing on
 * `indexOf` returning -1. A single-rung (or empty) `levels` never divides by
 * zero: the fill stays at 0%.
 */
export function resolveEffortSlider(
  levels: ReasoningEffort[],
  current: ReasoningEffort | undefined,
): EffortSliderState {
  const index = current ? Math.max(0, levels.indexOf(current)) : 0
  const pct = levels.length > 1 ? (index / (levels.length - 1)) * 100 : 0
  return { index, pct }
}
