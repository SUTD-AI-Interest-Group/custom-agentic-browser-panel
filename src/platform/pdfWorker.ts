// The PDF extraction worker: a module Worker that owns the pdf-inspector WASM
// instance and nothing else. A Vite entry point (dist/pdfWorker.js), spawned by
// pdfEngine.ts — never imported into a page bundle.
//
// Why off-thread at all: pdf-inspector's `processPdf` is SYNCHRONOUS once the
// module is initialized (its own README says to call it from a Web Worker for
// large documents). Measured at 218 ms for a 75-page paper and rising with page
// count, that is a hard block — on the main thread it would freeze the side
// panel mid-stream. pdf.js already ran its parse off-thread; this preserves that.
//
// The WASM is fetched here, by URL, rather than transferred in as bytes. That is
// the opposite of src/exec/host.ts, and deliberately so: the exec sandbox has an
// opaque origin and CANNOT fetch extension resources, whereas this worker is
// same-origin — so it can stream-compile straight from the extension's own
// asset and the main thread never has to hold 4.8 MB.

import init, { processPdf } from '@firecrawl/pdf-inspector-wasm'
import { pdfErrorMessage, type ExtractResult } from './pdfExtract'

/** host → worker. */
export type PdfWorkerRequest =
  | { type: 'init'; wasmUrl: string }
  | { type: 'extract'; id: string; bytes: ArrayBuffer; password?: string }

/** worker → host. */
export type PdfWorkerReply =
  | { type: 'ready' }
  | { type: 'boot-failed'; message: string }
  | { type: 'result'; id: string; result: ExtractResult }
  | { type: 'failed'; id: string; message: string }

const post = (msg: PdfWorkerReply) => self.postMessage(msg)

let started = false

self.onmessage = async (e: MessageEvent<PdfWorkerRequest>) => {
  const msg = e.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'init') {
    // The host only ever sends this once per worker, but a double-init would
    // be a silent no-op inside wasm-bindgen anyway — guard so the handshake
    // still resolves exactly once.
    if (started) return post({ type: 'ready' })
    started = true
    try {
      await init({ module_or_path: new URL(msg.wasmUrl, self.location.href) })
      post({ type: 'ready' })
    } catch (err) {
      started = false
      post({ type: 'boot-failed', message: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (msg.type === 'extract') {
    try {
      const r = processPdf(new Uint8Array(msg.bytes), {
        // Page markers are what let the single Markdown blob be split back into
        // the per-page model every consumer is addressed by (see pdfExtract.ts).
        includePageMarkers: true,
        // "fidelity" (the default) is source-faithful; "compact" trades layout
        // detail for tokens. Fidelity is right here — assemblePagesText already
        // budgets what actually reaches the model, so paying tokens twice would
        // be the only thing compact buys.
        profile: 'fidelity',
        ...(msg.password ? { password: msg.password } : {}),
      })
      post({
        type: 'result',
        id: msg.id,
        result: {
          pdfType: r.pdfType,
          markdown: r.markdown ?? '',
          pageCount: r.pageCount,
          title: r.title ?? '',
          pagesNeedingOcr: r.pagesNeedingOcr ?? [],
          hasEncodingIssues: r.hasEncodingIssues,
        },
      })
    } catch (err) {
      // Map here, not in the host: the raw Rust message ("process PDF: Not a
      // PDF: file appears to be HTML") never needs to cross the boundary, and
      // the host turns whatever arrives straight into a PdfError.
      post({ type: 'failed', id: msg.id, message: pdfErrorMessage(err instanceof Error ? err.message : String(err)) })
    }
  }
}
