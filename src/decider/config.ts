export type DeciderMode = 'off' | 'shadow' | 'assist'
export interface DeciderSettings {
  mode: DeciderMode
  actThreshold?: number
}

export const DEFAULT_ACT_THRESHOLD = 0.6
export const PREVIOUS_ACTIONS_WINDOW = 6
export const PAGE_TEXT_CAP = 1200
export const MODEL_ID = 'strands-decider-E2B-gemma4-v2-2611'
export const MODEL_STATUS_KEY = 'deciderModel'

export function normalizeDecider(raw: unknown): DeciderSettings | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (r.mode !== 'off' && r.mode !== 'shadow' && r.mode !== 'assist') return undefined
  const out: DeciderSettings = { mode: r.mode }
  const t = r.actThreshold
  if (typeof t === 'number' && Number.isFinite(t) && t >= 0.4 && t <= 0.95) out.actThreshold = t
  return out
}
