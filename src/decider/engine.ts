// Panel-side client for the decider worker — the PdfEngine analog. Owns one module Worker, boots
// it lazily, runs calls through a FIFO (one ORT session, one call at a time), rebuilds the
// worker when a round-trip wedges, and releases it after a period of inactivity. Panel-resident:
// never import this from the service worker.

import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import { MODEL_ID } from './config'
import type { DeciderWorkerReply, DeciderWorkerRequest, DecisionResult } from './protocol'
import type { DecisionRequest } from './request'

const DISPOSE_TIMEOUT_MS = 2000

export interface WorkerLike {
  postMessage(m: DeciderWorkerRequest): void
  addEventListener(t: 'message', l: (e: MessageEvent<DeciderWorkerReply>) => void): void
  terminate(): void
}

interface Job {
  req: DecisionRequest
  dropIfBusy: boolean
  maxTokens?: number
  resolve: (r: DecisionResult | null) => void
  reject: (e: Error) => void
}

interface InFlight {
  id: string
  reject: (e: Error) => void
  resolve: (r: DecisionResult) => void
  timer: ReturnType<typeof setTimeout>
}

export class DeciderEngine {
  private readonly spawn: () => WorkerLike
  private readonly bootTimeoutMs: number
  private readonly decideTimeoutMs: number
  private readonly idleMs: number

  private worker: WorkerLike | null = null
  private ready: Promise<void> | null = null
  private onReady: ((err?: Error) => void) | null = null
  private inFlight: InFlight | null = null
  private queue: Job[] = []
  private running = false
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(opts: { spawn?: () => WorkerLike; bootTimeoutMs?: number; decideTimeoutMs?: number; idleMs?: number } = {}) {
    this.spawn =
      opts.spawn ??
      (() => new Worker(chrome.runtime.getURL('deciderWorker.js'), { type: 'module' }) as unknown as WorkerLike)
    this.bootTimeoutMs = opts.bootTimeoutMs ?? 120_000
    this.decideTimeoutMs = opts.decideTimeoutMs ?? 30_000
    this.idleMs = opts.idleMs ?? 600_000
  }

  /** Boots the worker (model load) without deciding anything. */
  async warm(): Promise<void> {
    try {
      await this.ensure()
    } finally {
      if (!this.running && this.queue.length === 0) this.armIdle()
    }
  }

  /**
   * Queue one decision. With `dropIfBusy`, a still-queued earlier `dropIfBusy` call is replaced
   * (it resolves `null`), so a burst of stale snapshots collapses to the newest. With `maxTokens`,
   * a pass longer than that rejects `too-long` in the worker instead of running (driver mode's
   * dense-page cap); without it, only the hard cap applies.
   */
  decide(req: DecisionRequest, opts: { dropIfBusy?: boolean; maxTokens?: number } = {}): Promise<DecisionResult | null> {
    const dropIfBusy = !!opts.dropIfBusy
    const maxTokens = opts.maxTokens
    clearTimeout(this.idleTimer)
    return new Promise((resolve, reject) => {
      if (dropIfBusy) {
        this.queue = this.queue.filter((j) => {
          if (!j.dropIfBusy) return true
          j.resolve(null)
          return false
        })
      }
      this.queue.push({ req, dropIfBusy, maxTokens, resolve, reject })
      void this.pump()
    })
  }

  /**
   * Drops queued calls (they resolve null), fails the in-flight one, and asks the worker to close
   * its file handles before terminating it, so a caller can safely delete or re-import the model.
   */
  dispose(): Promise<void> {
    clearTimeout(this.idleTimer)
    for (const j of this.queue) j.resolve(null)
    this.queue = []
    return this.destroy(new Error('the decider engine was disposed'), true)
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        try {
          // Re-ensure per call: an earlier timeout may have torn the worker down.
          await this.ensure()
          job.resolve(await this.roundTrip(job.req, job.maxTokens))
        } catch (err) {
          job.reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
    } finally {
      this.running = false
      this.armIdle()
    }
  }

  private armIdle() {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.destroy(), this.idleMs)
  }

  private ensure(): Promise<void> {
    clearTimeout(this.idleTimer)
    if (!this.ready) this.ready = this.boot()
    return this.ready
  }

  private listener = (e: MessageEvent<DeciderWorkerReply>) => {
    const msg = e.data
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'ready') {
      this.onReady?.()
      this.onReady = null
      return
    }
    if (msg.type === 'boot-failed') {
      this.onReady?.(new Error(msg.message))
      this.onReady = null
      return
    }
    if (msg.type === 'disposed') return
    const f = this.inFlight
    if (!f || f.id !== msg.id) return
    this.inFlight = null
    clearTimeout(f.timer)
    if (msg.type === 'result') f.resolve(msg.result)
    else f.reject(new Error(msg.message))
  }

  private async boot(): Promise<void> {
    let worker: WorkerLike | null = null
    try {
      worker = this.spawn()
      worker.addEventListener('message', this.listener)
      // A worker that fails to parse fires `error`, never `message`.
      const spawned = worker
      const w = worker
      const target = worker as unknown as { addEventListener(t: 'error', l: (e: ErrorEvent) => void): void }
      target.addEventListener('error', (e) => {
        if (this.worker !== spawned) return
        const error = new Error(e.message || 'the decider worker crashed')
        this.onReady?.(error)
        this.destroy(error)
      })
      this.worker = worker
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('the decider did not start in time')), this.bootTimeoutMs)
        this.onReady = (err) => {
          clearTimeout(t)
          if (err) reject(err)
          else resolve()
        }
        w.postMessage({ type: 'init', modelId: MODEL_ID, wasmUrl })
      })
    } catch (err) {
      // Only tear down our own worker: a dispose during boot may already have replaced it.
      if (this.worker === worker) this.destroy()
      throw err
    }
  }

  private roundTrip(request: DecisionRequest, maxTokens?: number): Promise<DecisionResult> {
    return new Promise((resolve, reject) => {
      const worker = this.worker
      if (!worker) return reject(new Error('the decider is not running'))
      const id = crypto.randomUUID()
      const timer = setTimeout(() => {
        this.inFlight = null
        // A wedged session cannot be interrupted from outside; only a fresh worker recovers.
        this.destroy()
        reject(new Error('the decider stopped responding and was reset'))
      }, this.decideTimeoutMs)
      this.inFlight = { id, resolve, reject, timer }
      worker.postMessage(maxTokens === undefined ? { type: 'decide', id, request } : { type: 'decide', id, request, maxTokens })
    })
  }

  private destroy(reason?: Error, graceful = false): Promise<void> {
    clearTimeout(this.idleTimer)
    const worker = this.worker
    this.worker = null
    this.ready = null
    // Settle an in-progress boot so nothing waits on a worker that no longer exists.
    const pending = this.onReady
    this.onReady = null
    pending?.(reason ?? new Error('the decider was torn down'))
    const f = this.inFlight
    this.inFlight = null
    if (f) {
      clearTimeout(f.timer)
      f.reject(reason ?? new Error('the decider was torn down'))
    }
    if (!worker) return Promise.resolve()
    if (!graceful) {
      try {
        worker.postMessage({ type: 'dispose' })
      } catch {
        /* already dead */
      }
      worker.terminate()
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t)
        worker.terminate()
        resolve()
      }
      const t = setTimeout(done, DISPOSE_TIMEOUT_MS)
      worker.addEventListener('message', (e) => {
        if (e.data?.type === 'disposed') done()
      })
      try {
        worker.postMessage({ type: 'dispose' })
      } catch {
        done()
      }
    })
  }
}

let engine: DeciderEngine | null = null

/** The decider singleton (lazy; panel/page-like contexts only). */
export function getDeciderEngine(): DeciderEngine {
  if (!engine) engine = new DeciderEngine()
  return engine
}
