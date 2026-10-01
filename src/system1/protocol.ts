// Wire types between the panel (engine.ts) and the System-1 worker
// (worker.ts). Kept dependency-free of ort/tokenizer types so the panel side
// never needs to import onnxruntime-web just to talk about a request shape.

export interface DecideQuestion {
  instructions: string
  options: Record<string, string>
}
export interface DecideRequest {
  state: string
  questions: Record<string, DecideQuestion>
}
export interface DecideAnswer {
  choice: string
  probabilities: Record<string, number>
  /** Calibrated top probability — what ACT_CONFIDENCE gates on. */
  top: number
  /** TypeSafe margin confidence, reported for measurement. */
  confidence: number
}
export interface DecideResult {
  answers: Record<string, DecideAnswer>
  ms: number
  /** Only when the worker was booted with `profile: true` (the eval): every WebGPU kernel the decision ran, in order, with its GPU time. */
  kernels?: { name: string; ms: number }[]
}

export type System1WorkerRequest =
  | {
      type: 'init'
      wasmUrl: string
      modelUrl: string
      tokenizerUrl: string
      tokenizerConfigUrl: string
      configUrl: string
      /** From the manifest's `requiresShaderF16` — whether to request the WebGPU device with that feature. */
      requiresShaderF16: boolean
      /** Eval only: record per-kernel GPU timings (ORT's WebGPU profiler) and attach them to every result. Never set in production. */
      profile?: boolean
    }
  | { type: 'decide'; id: string; req: DecideRequest }

export type System1WorkerReply =
  | { type: 'ready' }
  | { type: 'boot-failed'; message: string }
  | { type: 'result'; id: string; result: DecideResult }
  | { type: 'failed'; id: string; message: string; code?: string }
