// From a question's logit row to its answer (strands_decider core/readout.py + confidence.py).
// p = softmax(tanh(z / c) * c / T) over the question's own k codes; ordinal smoothing is 0.

import type { RenderedQuestion } from './prompt'

export const CODE_ROWS_WIDTH = 255

export interface Answer {
  kind: 'choice' | 'noul' | 'score'
  options: string[]
  probs: number[]
  /** The option with the highest probability. */
  top: string
  /** Its probability. */
  p: number
  confidence: number
  /** Probability of 'true' (noul only). */
  yes?: number
}

export function codeProbabilities(
  logits: ArrayLike<number>,
  row: number,
  k: number,
  softcap: number,
  temperature: number,
): number[] {
  const base = row * CODE_ROWS_WIDTH
  const s: number[] = []
  for (let c = 0; c < k; c++) s.push((Math.tanh(logits[base + c] / softcap) * softcap) / temperature)
  const max = Math.max(...s)
  const e = s.map((v) => Math.exp(v - max))
  const sum = e.reduce((a, b) => a + b, 0)
  return e.map((v) => v / sum)
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

function choiceConfidence(p: number[]): number {
  const n = p.length
  if (n <= 1) return 1
  return clamp01((n * Math.max(...p) - 1) / (n - 1))
}

function scoreConfidence(probs: number[]): number {
  const n = probs.length
  if (n <= 1) return 1
  const total = probs.reduce((a, b) => a + b, 0)
  if (total <= 0) return 0
  const p = probs.map((x) => x / total)
  const mean = p.reduce((a, pi, i) => a + i * pi, 0)
  const sigma = Math.sqrt(p.reduce((a, pi, i) => a + pi * (i - mean) ** 2, 0))
  return clamp01(1 - sigma / ((n - 1) / 2))
}

export function toAnswer(q: RenderedQuestion, probs: number[]): Answer {
  let best = 0
  probs.forEach((v, i) => {
    if (v > probs[best]) best = i
  })
  const answer: Answer = {
    kind: q.kind,
    options: q.options,
    probs,
    top: q.options[best],
    p: probs[best],
    confidence: q.kind === 'score' ? scoreConfidence(probs) : choiceConfidence(probs),
  }
  if (q.kind === 'noul') answer.yes = probs[q.options.indexOf('true')]
  return answer
}
