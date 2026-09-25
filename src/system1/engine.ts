// Panel-side client for the System-1 worker — the pdfEngine.ts analog. One
// module Worker, booted lazily, FIFO-serialized (one WebGPU session; a queued
// call's timeout starts when it actually begins), rebuilt if a round trip
// wedges. `healthy` goes false on a boot failure, a decide timeout, or a
// post-boot worker crash — but only for HEALTH_COOLDOWN_MS, not forever: a
// fixed cooldown so resolveSystem1 stops offering Act right after a real
// failure without permanently stranding the whole panel session behind one
// transient wedge (the only other way back would be reloading the
// extension). A successful boot clears it immediately.
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import { WEIGHTS_PIN, fileUrl, loadCachedManifest, CACHE_NAME } from './weights'
import type { DecideRequest, DecideResult, System1WorkerReply, System1WorkerRequest } from './protocol'

// Reading ~400 MB from Cache Storage, compiling the ORT graph, and — via the
// warm-up run in worker.ts's boot() — compiling the actual WebGPU shader
// pipelines, which happens lazily on a session's first `run()` rather than in
// `InferenceSession.create()`. All of that has to fit here, not in
// DECIDE_TIMEOUT_MS.
const BOOT_TIMEOUT_MS = 120_000
const DECIDE_TIMEOUT_MS = 15_000
// How long `healthy` stays false after a failure before a later call is
// allowed to try booting again. Long enough that a genuinely broken
// environment (crashed GPU process, corrupted cache) isn't retried on every
// single turn; short enough that one transient wedge doesn't lock Act out of
// the rest of the session.
const HEALTH_COOLDOWN_MS = 60_000

interface Pending { resolve: (r: DecideResult) => void; reject: (e: Error) => void; timer: number }

/** Minimal surface this engine needs from a Worker — lets tests inject a fake (see officeEngine.ts's identical precedent). */
export interface WorkerLike {
  postMessage(msg: System1WorkerRequest): void
  addEventListener(type: 'message', listener: (e: MessageEvent<System1WorkerReply>) => void): void
  addEventListener(type: 'error', listener: (e: ErrorEvent) => void): void
  terminate(): void
}

const realWorkerFactory = (): WorkerLike =>
  new Worker(chrome.runtime.getURL('system1Worker.js'), { type: 'module' }) as unknown as WorkerLike

/**
 * `spawnWorker` is injectable (mirrors `OfficeEngine`'s `spawnWorker`,
 * `src/platform/officeEngine.ts`) specifically so the health-cooldown and
 * error-handling policy here can be exercised against a controllable fake
 * Worker under Vitest — there is no browser Worker or chrome.runtime
 * available there. See engine.test.ts.
 */
export class System1Engine {
  private worker: WorkerLike | null = null
  private ready: Promise<void> | null = null
  private onReady: ((err?: Error) => void) | null = null
  private pending = new Map<string, Pending>()
  private queue: Promise<void> = Promise.resolve()
  private _healthy = true
  private failedAt = 0

  constructor(private readonly spawnWorker: () => WorkerLike = realWorkerFactory) {}

  get healthy() {
    if (this._healthy) return true
    return Date.now() - this.failedAt >= HEALTH_COOLDOWN_MS
  }

  private markUnhealthy() {
    this._healthy = false
    this.failedAt = Date.now()
  }

  private listener = (e: MessageEvent<System1WorkerReply>) => {
    const m = e.data
    if (!m || typeof m !== 'object') return
    if (m.type === 'ready') { this.onReady?.(); this.onReady = null; return }
    if (m.type === 'boot-failed') { this.onReady?.(new Error(m.message)); this.onReady = null; return }
    const p = this.pending.get(m.id)
    if (!p) return
    this.pending.delete(m.id)
    clearTimeout(p.timer)
    if (m.type === 'result') p.resolve(m.result)
    else p.reject(Object.assign(new Error(m.message), { code: m.code }))
  }

  async decide(req: DecideRequest): Promise<DecideResult> {
    const previous = this.queue
    let release!: () => void
    this.queue = new Promise((r) => { release = r })
    await previous
    try {
      // Re-ensure per call, same reasoning as PdfEngine.extract: an earlier
      // call's timeout may have torn the worker down while this one waited.
      await this.ensure()
      const id = crypto.randomUUID()
      return await new Promise<DecideResult>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          this.pending.delete(id)
          this.markUnhealthy()
          this.destroy()
          reject(new Error('the System-1 engine stopped responding and was reset'))
        }, DECIDE_TIMEOUT_MS)
        this.pending.set(id, { resolve, reject, timer })
        this.worker!.postMessage({ type: 'decide', id, req } satisfies System1WorkerRequest)
      })
    } finally {
      release()
    }
  }

  private ensure() {
    if (!this.ready) this.ready = this.boot()
    return this.ready
  }

  private async boot() {
    try {
      const manifest = await loadCachedManifest(WEIGHTS_PIN, await caches.open(CACHE_NAME))
      if (!manifest) throw new Error('the System-1 model is not downloaded')
      const model = manifest.files.find((f) => f.path.endsWith('.onnx'))
      if (!model) throw new Error('the model manifest lists no .onnx file')
      const worker = this.spawnWorker()
      worker.addEventListener('message', this.listener)
      // A worker that fails to even parse fires `error`, never `message` — so
      // without this the ready gate would sit until its timeout for what is an
      // immediate, knowable failure. Same reasoning as PdfEngine.boot. A crash
      // AFTER boot (onReady already consumed) has no boot promise left to
      // reject, but may well have a `decide` in flight — left alone, that call
      // would just sit until its own DECIDE_TIMEOUT_MS. Fail it now instead.
      worker.addEventListener('error', (e) => {
        if (this.onReady) {
          this.onReady(new Error(e.message || 'System-1 worker failed to start'))
          this.onReady = null
          return
        }
        this.markUnhealthy()
        this.destroy()
      })
      this.worker = worker
      await new Promise<void>((resolve, reject) => {
        const t = window.setTimeout(() => reject(new Error('the System-1 engine did not start in time')), BOOT_TIMEOUT_MS)
        this.onReady = (err) => { clearTimeout(t); err ? reject(err) : resolve() }
        worker.postMessage({
          type: 'init',
          wasmUrl: new URL(wasmUrl, location.href).href,
          modelUrl: fileUrl(WEIGHTS_PIN, model.path),
          tokenizerUrl: fileUrl(WEIGHTS_PIN, 'tokenizer.json'),
          tokenizerConfigUrl: fileUrl(WEIGHTS_PIN, 'tokenizer_config.json'),
          configUrl: fileUrl(WEIGHTS_PIN, 'von.json'),
          requiresShaderF16: manifest.requiresShaderF16 === true,
        } satisfies System1WorkerRequest)
      })
      this._healthy = true
      this.failedAt = 0
    } catch (err) {
      this.markUnhealthy()
      this.destroy()
      throw err
    }
  }

  private destroy() {
    this.worker?.terminate()
    this.worker = null
    this.ready = null
    this.onReady = null
    // The FIFO means at most one decide is ever actually in flight, so this
    // only ever has that single wedged request to fail cleanly.
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('the System-1 engine was torn down')) }
    this.pending.clear()
  }
}

let engine: System1Engine | null = null
export function getSystem1Engine(): System1Engine {
  if (!engine) engine = new System1Engine()
  return engine
}
