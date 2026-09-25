// The System-1 worker: owns the ORT WebGPU session and the tokenizer, nothing
// else. A Vite entry (dist/system1Worker.js), spawned by engine.ts. Weights are
// read from Cache Storage (same extension origin) — never fetched from the
// network here; weights.ts is the only downloader.
import * as ort from 'onnxruntime-web/webgpu'
import { Tokenizer } from '@huggingface/tokenizers'
import { calibrate, marginConfidence, packPrompt, planSequence, VonInputError, type VonConfig } from './von'
import { CACHE_NAME } from './weights'
import type { DecideAnswer, DecideRequest, DecideResult, System1WorkerReply, System1WorkerRequest } from './protocol'

const post = (m: System1WorkerReply) => self.postMessage(m)
let session: ort.InferenceSession | null = null
let tokenizer: Tokenizer | null = null
let cfg: VonConfig | null = null

async function cached(url: string): Promise<Response> {
  const r = await (await caches.open(CACHE_NAME)).match(url)
  if (!r) throw new Error(`model file missing from cache: ${url.split('/').pop()}`)
  return r
}

// No "@webgpu/types" in this project (see runtime.ts) — this is the narrow
// surface `requestAdapter`/`requestDevice` actually need, typed by hand rather
// than pulling in a global ambient types package for six lines of use.
interface MinimalGpuAdapter {
  features: { has(name: string): boolean }
  requestDevice(desc?: { requiredFeatures?: string[] }): Promise<unknown>
}
interface MinimalGpu {
  requestAdapter(): Promise<MinimalGpuAdapter | null>
}

/**
 * Only the fp16 graph needs `shader-f16` — a weight-only quantized graph with
 * fp32 activations does not (see the manifest's `requiresShaderF16`). A
 * feature is only actually enabled on a device that requested it (an adapter
 * merely supporting it is not enough), so when it IS required this asks for
 * it explicitly rather than trusting a default device to have it.
 * `hasWebGpu()` (runtime.ts) already refused to offer Act without an adapter
 * that has the feature the manifest calls for, so a missing/insufficient
 * adapter here means that check raced a real environment change (e.g. the GPU
 * process died) between resolving the runtime and this boot — fail the boot,
 * don't silently fall back to a device without it.
 */
async function requestGpuDevice(requireF16: boolean): Promise<unknown> {
  const gpu = (navigator as Navigator & { gpu?: MinimalGpu }).gpu
  if (!gpu) throw new Error('WebGPU is not available in the System-1 worker')
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('no WebGPU adapter is available in the System-1 worker')
  if (requireF16 && !adapter.features.has('shader-f16'))
    throw new Error('the WebGPU adapter does not support shader-f16, which this model variant requires')
  return adapter.requestDevice(requireF16 ? { requiredFeatures: ['shader-f16'] } : undefined)
}

async function boot(m: Extract<System1WorkerRequest, { type: 'init' }>) {
  ort.env.wasm.wasmPaths = { wasm: m.wasmUrl }
  ort.env.wasm.numThreads = 1 // extension pages are not crossOriginIsolated
  const [model, tj, tc, c, device] = await Promise.all([
    cached(m.modelUrl).then((r) => r.arrayBuffer()),
    cached(m.tokenizerUrl).then((r) => r.json()),
    cached(m.tokenizerConfigUrl).then((r) => r.json()),
    cached(m.configUrl).then((r) => r.json()),
    requestGpuDevice(m.requiresShaderF16),
  ])
  tokenizer = new Tokenizer(tj, tc)
  cfg = c as VonConfig
  session = await ort.InferenceSession.create(new Uint8Array(model), {
    // Pass the shader-f16 device we just requested directly to the EP rather
    // than through the global `ort.env.webgpu.device` setter — that setter is
    // documented as "first-session-wins" process-wide state, which is the
    // wrong lifetime for a value scoped to one boot() call.
    executionProviders: [{ name: 'webgpu', device }],
    graphOptimizationLevel: 'all',
  })
}

async function scoreQuestion(state: string, q: DecideRequest['questions'][string]): Promise<DecideAnswer> {
  const keys = Object.keys(q.options)
  const packed = packPrompt(state, q.instructions, keys.map((k) => q.options[k]), cfg!.digitSplit)
  const ids = tokenizer!.encode(packed).ids
  const plan = planSequence(ids, cfg!.maskTokenId, cfg!.maxTokens)
  if (plan.markers.length !== keys.length)
    throw new VonInputError('no-options', `an option text contains a literal [MASK] (${plan.markers.length} ≠ ${keys.length})`)
  const T = ids.length
  const i64 = (xs: number[]) => BigInt64Array.from(xs, (x) => BigInt(x))
  const out = await session!.run({
    input_ids: new ort.Tensor('int64', i64(ids), [1, T]),
    option_ids: new ort.Tensor('int64', i64(plan.optionIds), [1, T]),
    position_ids: new ort.Tensor('int64', i64(plan.positionIds), [1, T]),
    marker_positions: new ort.Tensor('int64', i64(plan.markers), [plan.markers.length]),
  })
  const logits = Array.from(out.logits.data as Float32Array)
  const stateTokens = tokenizer!.encode(state, { add_special_tokens: false }).ids.length
  const probs = calibrate(logits, stateTokens, cfg!)
  let best = 0
  probs.forEach((p, i) => { if (p > probs[best]) best = i })
  return {
    choice: keys[best],
    probabilities: Object.fromEntries(keys.map((k, i) => [k, Math.round(probs[i] * 1e4) / 1e4])),
    top: probs[best],
    confidence: marginConfidence(probs),
  }
}

self.onmessage = async (e: MessageEvent<System1WorkerRequest>) => {
  const m = e.data
  if (!m || typeof m !== 'object') return
  if (m.type === 'init') {
    if (session) return post({ type: 'ready' })
    try {
      await boot(m)
      post({ type: 'ready' })
    } catch (err) {
      session = null
      post({ type: 'boot-failed', message: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  if (m.type === 'decide') {
    const t0 = performance.now()
    try {
      const answers: Record<string, DecideAnswer> = {}
      for (const [key, q] of Object.entries(m.req.questions)) answers[key] = await scoreQuestion(m.req.state, q)
      const result: DecideResult = { answers, ms: Math.round(performance.now() - t0) }
      post({ type: 'result', id: m.id, result })
    } catch (err) {
      post({
        type: 'failed', id: m.id,
        message: err instanceof Error ? err.message : String(err),
        code: err instanceof VonInputError ? err.code : undefined,
      })
    }
  }
}
