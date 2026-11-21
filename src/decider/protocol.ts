import type { DecisionRequest } from './request'
import type { Answer } from './readout'

export interface DecisionResult {
  answers: Record<string, Answer>
  ms: number
  tokens: number
  backend: 'webgpu' | 'wasm'
  cold: boolean
}

export type DeciderWorkerRequest =
  | { type: 'init'; modelId: string; wasmUrl: string }
  | { type: 'decide'; id: string; request: DecisionRequest }
  | { type: 'dispose' }

export type DeciderWorkerReply =
  | { type: 'ready'; backend: 'webgpu' | 'wasm'; bootMs: number }
  | { type: 'boot-failed'; message: string }
  | { type: 'result'; id: string; result: DecisionResult }
  | { type: 'failed'; id: string; message: string }
  | { type: 'disposed' }
