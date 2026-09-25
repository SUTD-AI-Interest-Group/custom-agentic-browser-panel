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
}

export type System1WorkerRequest =
  | { type: 'init'; wasmUrl: string; modelUrl: string; tokenizerUrl: string; tokenizerConfigUrl: string; configUrl: string }
  | { type: 'decide'; id: string; req: DecideRequest }

export type System1WorkerReply =
  | { type: 'ready' }
  | { type: 'boot-failed'; message: string }
  | { type: 'result'; id: string; result: DecideResult }
  | { type: 'failed'; id: string; message: string; code?: string }
