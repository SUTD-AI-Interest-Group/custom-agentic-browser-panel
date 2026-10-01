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
  /** `fast`: the export of scripts/export-von/fast.py — RoPE tables and option masks are inputs (see buildFastInputs). Absent: the legacy graph. */
  inputs?: 'fast'
  padTokenId?: number
  headDim?: number
  rope?: { full: number; sliding: number }
  buckets?: number[]
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

/**
 * The fast graph (scripts/export-von/fast.py): RoPE tables and the two option
 * masks are INPUTS, built here exactly as fast_inputs() builds them in Python
 * — the golden fixture and the eval's WebGPU parity phase are what keep the
 * two from drifting. T is padded to a bucket so WebGPU shader pipelines are
 * reused across requests; a pad token has option id −2 and position 0, is
 * masked from every real row, and still sees itself so no softmax row is
 * empty. Cost: the biases are T×T floats each (4.8 MB at T=1,100), built in
 * ~5 ms; the tables are T×64.
 */
export const FAST_BUCKETS = [256, 512, 768, 1024, 1536, 2048, 3072, 4096]
export const NEG_BIAS = -30000

export interface FastConfig {
  padTokenId: number
  slidingWindow: number
  headDim: number
  rope: { full: number; sliding: number }
}
export interface FastInputs {
  T: number
  ids: number[]
  cosFull: Float32Array
  sinFull: Float32Array
  cosSliding: Float32Array
  sinSliding: Float32Array
  biasFull: Float32Array
  biasSliding: Float32Array
}

/** The smallest bucket that holds T tokens; past the last one the input is too long, exactly like planSequence's own limit. */
export function bucketFor(T: number, maxTokens: number): number {
  for (const b of FAST_BUCKETS) if (T <= b && b <= maxTokens) return b
  throw new VonInputError('too-long', `packed input is ${T} tokens (max ${Math.min(maxTokens, FAST_BUCKETS[FAST_BUCKETS.length - 1])})`)
}

/** cos/sin per token ROW from its (reset) position id: ModernBertRotaryEmbedding in fp32, cat(freqs, freqs). */
function ropeTable(positions: number[], theta: number, headDim: number): { cos: Float32Array; sin: Float32Array } {
  const half = headDim / 2
  const inv = Array.from({ length: half }, (_, i) => Math.fround(1 / Math.pow(theta, (2 * i) / headDim)))
  const cos = new Float32Array(positions.length * headDim)
  const sin = new Float32Array(positions.length * headDim)
  positions.forEach((p, r) => {
    for (let i = 0; i < half; i++) {
      const a = Math.fround(p * inv[i])
      const c = Math.cos(a)
      const s = Math.sin(a)
      cos[r * headDim + i] = c
      cos[r * headDim + half + i] = c
      sin[r * headDim + i] = s
      sin[r * headDim + half + i] = s
    }
  })
  return { cos, sin }
}

export function buildFastInputs(ids: number[], plan: SequencePlan, cfg: FastConfig): FastInputs {
  const T = bucketFor(ids.length, FAST_BUCKETS[FAST_BUCKETS.length - 1])
  const pad = T - ids.length
  const padded = [...ids, ...Array<number>(pad).fill(cfg.padTokenId)]
  const oi = [...plan.optionIds, ...Array<number>(pad).fill(-2)]
  const pi = [...plan.positionIds, ...Array<number>(pad).fill(0)]
  const biasFull = new Float32Array(T * T)
  const biasSliding = new Float32Array(T * T)
  for (let i = 0; i < T; i++) {
    const qp = oi[i] === -1
    const row = i * T
    for (let j = 0; j < T; j++) {
      const kp = oi[j] === -1
      // VonExport.forward's rule: prefix↔prefix; an option sees the prefix and its own span; the diagonal always.
      const allowed = qp ? kp : kp || oi[i] === oi[j]
      const full = allowed || i === j
      const sliding = (allowed && Math.abs(pi[i] - pi[j]) <= cfg.slidingWindow) || i === j
      biasFull[row + j] = full ? 0 : NEG_BIAS
      biasSliding[row + j] = sliding ? 0 : NEG_BIAS
    }
  }
  const f = ropeTable(pi, cfg.rope.full, cfg.headDim)
  const s = ropeTable(pi, cfg.rope.sliding, cfg.headDim)
  return { T, ids: padded, cosFull: f.cos, sinFull: f.sin, cosSliding: s.cos, sinSliding: s.sin, biasFull, biasSliding }
}

/** TypeSafe's confidence: (n·pmax − 1)/(n − 1), anchored to the 1/n chance baseline. */
export function marginConfidence(probs: number[]): number {
  const n = probs.length
  if (n <= 1) return 1
  const c = (n * Math.max(...probs) - 1) / (n - 1)
  return Math.round(Math.max(0, Math.min(1, c)) * 1000) / 1000
}
