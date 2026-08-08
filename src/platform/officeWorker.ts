// The office-document parsing worker: a module Worker that owns nothing but
// the (lazily loaded) officeParser slim bundle. A Vite entry point
// (dist/officeWorker.js), spawned by officeEngine.ts — never imported into a
// page bundle. Mirrors pdfWorker.ts's shape and reasoning.
//
// Why off-thread at all: officeParser's AST walk is synchronous, and for a
// pathological XLSX (H1/C1: see officeCellBudget.ts) it can run long even
// once bounded. Running it here means a wedged parse freezes this worker, not
// the side panel — officeEngine.ts's wall-clock timeout terminates and rebuilds
// it, exactly like ExecHost/pdfEngine.

import { parseOfficeBytes } from './officeParse'
import type { OfficeDoc } from './officeText'

/** host → worker. */
export type OfficeWorkerRequest =
  | { type: 'init' }
  | { type: 'parse'; id: string; bytes: ArrayBuffer; name: string; mimeType: string }

/** worker → host. */
export type OfficeWorkerReply =
  | { type: 'ready' }
  | { type: 'boot-failed'; message: string }
  | { type: 'result'; id: string; doc: OfficeDoc }
  | { type: 'failed'; id: string; message: string }

const post = (msg: OfficeWorkerReply) => self.postMessage(msg)

let booted = false

self.onmessage = async (e: MessageEvent<OfficeWorkerRequest>) => {
  const msg = e.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'init') {
    // The host only ever sends this once per worker, but a double-init would
    // be a silent no-op anyway — guard so the handshake still resolves once.
    if (booted) return post({ type: 'ready' })
    try {
      // Pre-warm the ~845 KB dynamic chunk here rather than on the first real
      // parse call, so per-call latency is predictable once booted.
      await import('officeparser/slim')
      booted = true
      post({ type: 'ready' })
    } catch (err) {
      post({ type: 'boot-failed', message: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (msg.type === 'parse') {
    try {
      const doc = await parseOfficeBytes(new Uint8Array(msg.bytes), msg.name, msg.mimeType)
      post({ type: 'result', id: msg.id, doc })
    } catch (err) {
      post({ type: 'failed', id: msg.id, message: err instanceof Error ? err.message : String(err) })
    }
  }
}
