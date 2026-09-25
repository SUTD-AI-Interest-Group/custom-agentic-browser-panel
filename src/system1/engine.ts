// Panel-side client for the System-1 worker — the pdfEngine.ts analog. One
// module Worker, booted lazily, FIFO-serialized (one WebGPU session; a queued
// call's timeout starts when it actually begins), rebuilt if a round trip
// wedges. `healthy` goes false on a boot failure or wedge so resolveSystem1
// stops offering Act until a later boot succeeds.
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import { WEIGHTS_PIN, fileUrl, loadCachedManifest, CACHE_NAME } from './weights'
import type { DecideRequest, DecideResult, System1WorkerReply, System1WorkerRequest } from './protocol'

// Reading ~400 MB from Cache Storage and compiling WebGPU pipelines, cold.
const BOOT_TIMEOUT_MS = 120_000
const DECIDE_TIMEOUT_MS = 15_000

interface Pending { resolve: (r: DecideResult) => void; reject: (e: Error) => void; timer: number }

export class System1Engine {
  private worker: Worker | null = null
  private ready: Promise<void> | null = null
  private onReady: ((err?: Error) => void) | null = null
  private pending = new Map<string, Pending>()
  private queue: Promise<void> = Promise.resolve()
  private _healthy = true

  get healthy() { return this._healthy }

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
          this._healthy = false
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
      const worker = new Worker(chrome.runtime.getURL('system1Worker.js'), { type: 'module' })
      worker.addEventListener('message', this.listener)
      // A worker that fails to even parse fires `error`, never `message` — so
      // without this the ready gate would sit until its timeout for what is an
      // immediate, knowable failure. Same reasoning as PdfEngine.boot.
      worker.addEventListener('error', (e) => { this.onReady?.(new Error(e.message || 'System-1 worker failed to start')); this.onReady = null })
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
    } catch (err) {
      this._healthy = false
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
