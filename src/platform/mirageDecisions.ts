import type { MirageObservations } from './miragePerception'

export type DecisionMode = 'off' | 'shadow' | 'assist'
export const decisionMode = (value: unknown): DecisionMode => value === 'shadow' || value === 'assist' ? value : 'off'
const labels = ['dialog', 'form', 'document', 'other'] as const
type ScreenType = typeof labels[number]
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Closed-choice likelihoods are NOT calibrated task-success probabilities. */
export function analyzeMirageDecision(raw: unknown) {
  const field = object(object(object(raw).form).screen_type)
  const probabilities = object(field.probabilities)
  const keys = Object.keys(probabilities)
  const allowed: string[] = [...labels, '-']
  if (!labels.every(label => Object.hasOwn(probabilities, label)) || keys.some(key => !allowed.includes(key))) return { status: 'abstain' as const, reason: 'invalid-result' }
  const scores = keys.map(key => probabilities[key])
  if (scores.some(score => typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) return { status: 'abstain' as const, reason: 'invalid-probabilities' }
  const total = (scores as number[]).reduce((a, b) => a + b, 0)
  if (Math.abs(total - 1) > 0.02) return { status: 'abstain' as const, reason: 'invalid-probabilities' }
  const value = field.value
  if (value === null || value === '-') return { status: 'abstain' as const, reason: 'model-abstained' }
  if (typeof value !== 'string' || !labels.includes(value as ScreenType)) return { status: 'abstain' as const, reason: 'invalid-label' }
  const probability = probabilities[value] as number
  const runnerUp = Math.max(...keys.filter(key => key !== value).map(key => probabilities[key] as number))
  const margin = probability - runnerUp
  if (value === 'other' || probability < 0.8 || margin < 0.2) return { status: 'abstain' as const, reason: 'uncertain-or-unsupported' }
  return { status: 'advisory' as const, visualClass: value as Exclude<ScreenType, 'other'>, probability, margin,
    routingHint: { tool: 'ReadPage' as const, mode: value === 'document' ? 'text' as const : 'elements' as const },
    note: 'Image-only read-tool suggestion. No user intent or chat history was classified. The planner chooses whether to call a tool and supplies its arguments through the existing approval gate.' }
}

/** Reversible representation only: never selects messages, drops OCR, or summarizes. */
export function packVisualObservations(observations: MirageObservations, decision: ReturnType<typeof analyzeMirageDecision>) {
  const beforeBytes = new TextEncoder().encode(JSON.stringify(observations)).length
  const packed = {
    format: 'mirage-tuples-v1' as const,
    tupleSchema: 'text=[text,score,bbox]; objects=[name,score,bbox]; null bbox means absent',
    boxScale: observations.boxScale,
    text: observations.text.map(r => [r.text, r.score, r.bbox ?? null]),
    objects: observations.objects.map(r => [r.name, r.score, r.bbox ?? null]),
  }
  const candidateBytes = new TextEncoder().encode(JSON.stringify(packed)).length
  const applied = decision.status === 'advisory' && candidateBytes < beforeBytes
  return {
    observations: applied ? packed : observations,
    packing: { scope: 'this-visual-observation-only', applied, beforeBytes, afterBytes: applied ? candidateBytes : beforeBytes,
      note: 'All retained OCR text, objects, scores and boxes are preserved. Bytes are UTF-8 JSON payload size, not tokenizer counts. Conversation history, user instructions, tool pairs and summaries are unchanged.' },
  }
}
