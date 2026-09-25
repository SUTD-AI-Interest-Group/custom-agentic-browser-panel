// Pure mirror of Von 1.2's option-marker input construction and calibration
// (von/models/option_marker.py, von/backends/option_marker_backend.py at
// ca5d608). Every function here has a Python twin; the golden fixture, produced
// by scripts/export-von/export.py from the real checkpoint, is what keeps the
// two from drifting. Change nothing here without regenerating it.

export interface CalibrationMap {
  bias?: number
  entropy?: number
  log_tokens?: number
  n_options?: number
  lo?: number
  hi?: number
}

export interface VonConfig {
  model: string
  maskTokenId: number
  clsTokenId: number
  sepTokenId: number
  slidingWindow: number
  maxTokens: number
  digitSplit: boolean
  temperature: number
  calibrationMap: CalibrationMap | null
}

export interface SequencePlan {
  optionIds: number[]
  positionIds: number[]
  markers: number[]
}

export class VonInputError extends Error {
  constructor(public code: 'too-long' | 'no-options', message: string) {
    super(message)
  }
}

const splitDigits = (s: string) => s.replace(/\d+/g, (run) => run.split('').join(' '))

/** Von's `pack_sequence`: `"{instructions} {state}" [SEP] [MASK] opt0 [MASK] opt1 …`. */
export function packPrompt(state: string, instructions: string, options: string[], digitSplit: boolean): string {
  const prefix = instructions ? `${instructions} ${state}`.trim() : state.trim()
  const opts = options.map((o) => `[MASK] ${o.trim()}`).join(' ')
  const packed = `${prefix} [SEP] ${opts}`
  return digitSplit ? splitDigits(packed) : packed
}

/**
 * Option spans + order-invariant position ids for one tokenized sequence
 * (batch 1, no padding). Each option's span runs from its [MASK] to the next
 * [MASK]; the LAST span stops before the trailing [SEP], which stays
 * prefix-class so no slot is special. Every span's positions restart at the
 * first marker's index (the prefix length).
 */
export function planSequence(ids: number[], maskTokenId: number, maxTokens: number): SequencePlan {
  if (ids.length > maxTokens)
    throw new VonInputError('too-long', `packed input is ${ids.length} tokens (max ${maxTokens})`)
  const markers: number[] = []
  ids.forEach((t, i) => {
    if (t === maskTokenId) markers.push(i)
  })
  if (markers.length === 0) throw new VonInputError('no-options', 'no [MASK] markers in packed input')
  const last = ids.length - 1
  const optionIds = ids.map(() => -1)
  const positionIds = ids.map((_, i) => i)
  const prefixLen = markers[0]
  markers.forEach((start, k) => {
    const end = k + 1 < markers.length ? markers[k + 1] : last
    for (let j = start; j < end; j++) {
      optionIds[j] = k
      positionIds[j] = prefixLen + (j - start)
    }
  })
  return { optionIds, positionIds, markers }
}

function softmax(xs: number[]): number[] {
  const m = Math.max(...xs)
  const e = xs.map((x) => Math.exp(x - m))
  const s = e.reduce((a, b) => a + b, 0)
  return e.map((x) => x / s)
}

/** Von's input-conditioned temperature, then softmax. Monotonic: never moves the argmax. */
export function calibrate(
  logits: number[],
  stateTokens: number,
  cfg: { temperature: number; calibrationMap: CalibrationMap | null },
): number[] {
  const m = cfg.calibrationMap
  let t = cfg.temperature
  if (m) {
    const p = softmax(logits)
    const n = p.length
    const ent = n > 1 ? -p.reduce((a, x) => a + x * Math.log(Math.max(x, 1e-12)), 0) / Math.log(n) : 0
    const raw =
      (m.bias ?? 0) +
      (m.entropy ?? 0) * ent +
      (m.log_tokens ?? 0) * (Math.log10(Math.max(stateTokens, 1)) / 4) +
      (m.n_options ?? 0) * (n / 8)
    t = Math.min(m.hi ?? 12, Math.max(m.lo ?? 0.5, raw))
  }
  const denom = Math.max(t, 1e-4)
  return softmax(logits.map((x) => x / denom))
}

/** TypeSafe's confidence: (n·pmax − 1)/(n − 1), anchored to the 1/n chance baseline. */
export function marginConfidence(probs: number[]): number {
  const n = probs.length
  if (n <= 1) return 1
  const c = (n * Math.max(...probs) - 1) / (n - 1)
  return Math.round(Math.max(0, Math.min(1, c)) * 1000) / 1000
}
