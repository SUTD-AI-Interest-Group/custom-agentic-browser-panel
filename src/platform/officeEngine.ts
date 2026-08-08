// Panel/offscreen-side client for the office-parsing worker — the pdfEngine.ts
// analog for this subsystem (H1: officeParser previously ran inline in the
// side panel's main JS realm, no Worker, no timeout). Owns one module Worker,
// boots it lazily on first use, serializes calls through a FIFO, and rebuilds
// the worker if a round-trip wedges. Runs only in page-like contexts (side
// panel, offscreen host); the MV3 service worker never imports it, same as
// office.ts.

import type { OfficeWorkerReply, OfficeWorkerRequest } from './officeWorker'
import type { OfficeDoc } from './officeText'

// officeParser/slim is ~845 KB (per office.ts's original comment) versus
// pdf-inspector's 4.8 MB WASM module (pdfEngine.ts's BOOT_TIMEOUT_MS is 30s) —
// proportionally lighter to fetch+eval, but padded generously past that ratio
// since cold-cache/disk-contention variance matters more than raw bundle size
// at this scale. A false positive here tears the worker down on what may just
// be a slow first load.
const BOOT_TIMEOUT_MS = 20_000
// Office attachments are capped at 25 MB (MAX_OFFICE_BYTES in office.ts,
// smaller than PDF's 50 MB cap) and, since C1, XLSX cell cost is bounded by
// officeCellBudget.ts before the real parse ever starts. Legitimate parses
// should finish in well under this. Matches pdfEngine.ts's EXTRACT_TIMEOUT_MS:
// this is a wedge detector, not a performance budget.
const PARSE_TIMEOUT_MS = 60_000

/** Minimal surface this engine needs from a Worker — lets tests inject a fake. */
export interface WorkerLike {
  postMessage(msg: OfficeWorkerRequest, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (e: MessageEvent<OfficeWorkerReply>) => void): void
  addEventListener(type: 'error', listener: (e: ErrorEvent) => void): void
  terminate(): void
}

const realWorkerFactory = (): WorkerLike =>
  new Worker(chrome.runtime.getURL('officeWorker.js'), { type: 'module' }) as unknown as WorkerLike

interface Pending {
  resolve: (doc: OfficeDoc) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Exported for testing; getOfficeEngine() is the real singleton.
 *
 * `spawnWorker` is injectable (pdfEngine.ts's PdfEngine hardcodes the real
 * `new Worker(...)` call inline in `boot()`) specifically so the FIFO/timeout/
 * wedge-recovery policy here can be exercised against a controllable fake
 * Worker under Vitest — there is no browser Worker or chrome.runtime available
 * there, and unlike PdfEngine's WASM extraction, this queueing logic is cheap
 * enough to be worth testing directly rather than only via manual
 * /verify-extension. See officeEngine.test.ts.
 */
export class OfficeEngine {
  private worker: WorkerLike | null = null
  private ready: Promise<void> | null = null
  private pending = new Map<string, Pending>()
  private onReady: ((err?: Error) => void) | null = null
  // Same rationale as ExecHost.runQueue / PdfEngine.queue: officeParser's AST
  // walk is synchronous, so a worker can never truly service two parses at
  // once regardless. Queuing explicitly means a call's timeout clock starts
  // when it actually begins rather than while it waits its turn, and it means
  // a teardown never has more than one genuinely in-flight request to reject.
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly spawnWorker: () => WorkerLike = realWorkerFactory) {}

  private listener = (e: MessageEvent<OfficeWorkerReply>) => {
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
    if (msg.type === 'result') p.resolve(msg.doc)
    else p.reject(new Error(msg.message))
  }

  /**
   * Parse one document. `bytes` is COPIED before being transferred, so the
   * caller's array survives — an attachment's bytes are held by the cache/
   * caller for reuse across turns and must not be detached out from under it.
   */
  async parse(bytes: Uint8Array, name: string, mimeType: string): Promise<OfficeDoc> {
    const previous = this.queue
    let releaseTurn!: () => void
    this.queue = new Promise((resolve) => {
      releaseTurn = resolve
    })
    await previous
    try {
      // Re-ensure per call: an earlier call's timeout may have torn the
      // worker down while this one waited, and a queued call deserves a real
      // attempt against a live worker rather than failing on a corpse.
      await this.ensure()
      const copy = bytes.slice()
      return await this.roundTrip(
        { type: 'parse', id: crypto.randomUUID(), bytes: copy.buffer as ArrayBuffer, name, mimeType },
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

  // A worker that fails to even parse fires `error`, never `message` — so
  // during boot, without this the ready gate would sit until its timeout for
  // what is an immediate, knowable failure. This handler stays registered for
  // the worker's WHOLE lifetime (not just during boot), because a genuine
  // runtime crash mid-parse also fires `error`, and `onReady` is already null
  // by then — without also rejecting `pending` and tearing down here, that
  // crash would go unnoticed until the blind 60s PARSE_TIMEOUT_MS elapsed,
  // even though the worker is already gone. With C1's guard failing open on
  // its own scan errors, "worker + timeout" is the sole backstop against a
  // bypass, so it must not itself be slower to notice a hard failure than it
  // has to be.
  private handleWorkerError = (e: ErrorEvent) => {
    const err = new Error(e.message || 'the office document worker crashed')
    this.onReady?.(err)
    this.onReady = null
    this.destroy(err)
  }

  private async boot(): Promise<void> {
    try {
      const worker = this.spawnWorker()
      worker.addEventListener('message', this.listener)
      worker.addEventListener('error', this.handleWorkerError)
      this.worker = worker
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error('the office document engine did not start in time')),
          BOOT_TIMEOUT_MS,
        )
        this.onReady = (err) => {
          clearTimeout(t)
          if (err) reject(err)
          else resolve()
        }
        worker.postMessage({ type: 'init' })
      })
    } catch (err) {
      this.destroy()
      throw err
    }
  }

  private roundTrip(
    msg: Extract<OfficeWorkerRequest, { type: 'parse' }>,
    transfer: Transferable[],
  ): Promise<OfficeDoc> {
    return new Promise((resolve, reject) => {
      const worker = this.worker
      if (!worker) return reject(new Error('the office document engine is not running'))
      const timer = setTimeout(() => {
        this.pending.delete(msg.id)
        // A wedged parse cannot be interrupted from outside — the only way
        // back is a fresh worker for whoever calls next.
        this.destroy()
        reject(new Error('the office document engine stopped responding and was reset'))
      }, PARSE_TIMEOUT_MS)
      this.pending.set(msg.id, { resolve, reject, timer })
      worker.postMessage(msg, transfer)
    })
  }

  /**
   * `reason`, when given, is why the pending call actually failed (e.g. a
   * worker crash) — the caller already built the real Error; passing it
   * through here means `handleWorkerError`'s `/crashed/`-shaped message
   * reaches the caller instead of being overwritten by this generic one.
   */
  private destroy(reason?: Error) {
    this.worker?.terminate()
    this.worker = null
    this.ready = null
    this.onReady = null
    // The FIFO means at most one parse is ever actually posted, so this only
    // ever has the single wedged/crashed request to fail cleanly.
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(reason ?? new Error('the office document engine was torn down'))
    }
    this.pending.clear()
  }
}

let engine: OfficeEngine | null = null

/** The office-parsing singleton (lazy; safe to import anywhere page-like). */
export function getOfficeEngine(): OfficeEngine {
  if (!engine) engine = new OfficeEngine()
  return engine
}
