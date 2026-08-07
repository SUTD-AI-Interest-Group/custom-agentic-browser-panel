// Panel/offscreen-side client for the PDF extraction worker — the ExecHost
// analog for this subsystem. Owns one module Worker, boots it lazily on first
// use, serializes calls through a FIFO, and rebuilds the worker if a round-trip
// wedges. Runs only in page-like contexts (side panel, offscreen host); the MV3
// service worker never imports it, same as pdf.ts.

import wasmUrl from '@firecrawl/pdf-inspector-wasm/pdf_inspector_wasm_bg.wasm?url'
import type { ExtractResult } from './pdfExtract'
import type { PdfWorkerReply, PdfWorkerRequest } from './pdfWorker'

// Fetch + compile of a 4.8 MB module, cold. Generous: blowing this budget tears
// the worker down, and a false positive would do that on a slow first run.
const BOOT_TIMEOUT_MS = 30_000
// Extraction is bounded by the 50 MB / 500-page caps upstream; measured at
// 218 ms for 75 pages. This is a wedge detector, not a performance budget.
const EXTRACT_TIMEOUT_MS = 60_000

interface Pending {
  resolve: (r: ExtractResult) => void
  reject: (err: Error) => void
  timer: number
}

/** Exported for testing; getPdfEngine() is the real singleton. */
export class PdfEngine {
  private worker: Worker | null = null
  private ready: Promise<void> | null = null
  private pending = new Map<string, Pending>()
  private onReady: ((err?: Error) => void) | null = null
  // Same rationale as ExecHost.runQueue: the WASM is one single-threaded realm
  // and processPdf is synchronous, so it can never service two extractions at
  // once regardless. Queuing explicitly means a call's timeout clock starts
  // when it actually begins rather than while it waits its turn, and it means a
  // teardown never has more than one genuinely in-flight request to reject.
  private queue: Promise<void> = Promise.resolve()

  private listener = (e: MessageEvent<PdfWorkerReply>) => {
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
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.type === 'result') p.resolve(msg.result)
    else p.reject(new Error(msg.message))
  }

  /**
   * Extract one document. `bytes` is COPIED before being transferred, so the
   * caller's array survives — an attachment's bytes are held for the life of
   * the composer and must not be detached out from under it.
   */
  async extract(bytes: Uint8Array, opts?: { password?: string }): Promise<ExtractResult> {
    const previous = this.queue
    let releaseTurn!: () => void
    this.queue = new Promise((resolve) => {
      releaseTurn = resolve
    })
    await previous
    try {
      // Re-ensure per call: an earlier call's timeout may have torn the worker
      // down while this one waited, and a queued call deserves a real attempt
      // against a live worker rather than failing on a corpse.
      await this.ensure()
      const copy = bytes.slice()
      return await this.roundTrip(
        { type: 'extract', id: crypto.randomUUID(), bytes: copy.buffer as ArrayBuffer, ...opts },
        EXTRACT_TIMEOUT_MS,
        [copy.buffer as ArrayBuffer],
      )
    } finally {
      releaseTurn()
    }
  }

  private ensure(): Promise<void> {
    if (!this.ready) this.ready = this.boot()
    return this.ready
  }

  private async boot(): Promise<void> {
    try {
      const worker = new Worker(chrome.runtime.getURL('pdfWorker.js'), { type: 'module' })
      worker.addEventListener('message', this.listener)
      // A worker that fails to even parse fires `error`, never `message` — so
      // without this the ready gate would sit until its timeout for what is
      // an immediate, knowable failure.
      worker.addEventListener('error', (e) => {
        this.onReady?.(new Error(e.message || 'the PDF worker failed to start'))
        this.onReady = null
      })
      this.worker = worker
      await new Promise<void>((resolve, reject) => {
        const t = window.setTimeout(
          () => reject(new Error('the PDF engine did not start in time')),
          BOOT_TIMEOUT_MS,
        )
        this.onReady = (err) => {
          clearTimeout(t)
          if (err) reject(err)
          else resolve()
        }
        worker.postMessage({ type: 'init', wasmUrl } satisfies PdfWorkerRequest)
      })
    } catch (err) {
      this.destroy()
      throw err
    }
  }

  private roundTrip(
    msg: Extract<PdfWorkerRequest, { type: 'extract' }>,
    timeoutMs: number,
    transfer: Transferable[],
  ): Promise<ExtractResult> {
    return new Promise((resolve, reject) => {
      const worker = this.worker
      if (!worker) return reject(new Error('the PDF engine is not running'))
      const timer = window.setTimeout(() => {
        this.pending.delete(msg.id)
        // A wedged WASM call cannot be interrupted from outside — the only way
        // back is a fresh worker for whoever calls next.
        this.destroy()
        reject(new Error('the PDF engine stopped responding and was reset'))
      }, timeoutMs)
      this.pending.set(msg.id, { resolve, reject, timer })
      worker.postMessage(msg, transfer)
    })
  }

  private destroy() {
    this.worker?.terminate()
    this.worker = null
    this.ready = null
    this.onReady = null
    // The FIFO means at most one extract is ever actually posted, so this only
    // ever has the single wedged request to fail cleanly.
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('the PDF engine was torn down'))
    }
    this.pending.clear()
  }
}

let engine: PdfEngine | null = null

/** The PDF extraction singleton (lazy; safe to import anywhere page-like). */
export function getPdfEngine(): PdfEngine {
  if (!engine) engine = new PdfEngine()
  return engine
}
