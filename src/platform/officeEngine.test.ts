// Tests the FIFO/timeout/wedge-recovery POLICY in OfficeEngine against a fake
// Worker — there is no browser Worker or chrome.runtime under Vitest, which is
// exactly why OfficeEngine takes an injectable `spawnWorker` (see its own
// comment). The real parse logic (officeParse.ts) and the real worker
// round-trip are out of scope here by design; office.test.ts covers the
// former end-to-end via a mock that delegates to it, and the worker itself is
// verified manually via /verify-extension, matching this codebase's existing
// pdfEngine.ts precedent (no direct pdfEngine test exists either).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OfficeEngine, type WorkerLike } from './officeEngine'
import type { OfficeWorkerReply, OfficeWorkerRequest } from './officeWorker'
import type { OfficeDoc } from './officeText'

type Behavior = 'ok' | 'wedge' | 'boot-fail'

const DOC: OfficeDoc = { shape: 'prose', format: 'docx', segments: [{ label: 'Document', text: 'hello' }], imageCount: 0 }

/** A controllable fake Worker. `behavior` is read at postMessage-time, so a
 * test can swap it between calls without needing a new factory per case. */
class FakeWorker implements WorkerLike {
  posted: OfficeWorkerRequest[] = []
  terminated = false
  private messageListeners: ((e: MessageEvent<OfficeWorkerReply>) => void)[] = []
  private errorListeners: ((e: ErrorEvent) => void)[] = []

  constructor(private behavior: () => Behavior) {}

  // Recording (`posted`) and replying are split so a subclass can defer JUST
  // the reply (see GatedWorker below) while `posted` still reflects what was
  // sent the instant it was sent — matching what the real Worker's
  // postMessage does (fire-and-forget; the reply is a separate async event).
  postMessage(msg: OfficeWorkerRequest) {
    this.posted.push(msg)
    this.reply(msg)
  }

  protected reply(msg: OfficeWorkerRequest) {
    const behavior = this.behavior()
    if (msg.type === 'init') {
      if (behavior === 'boot-fail') this.emit({ type: 'boot-failed', message: 'simulated boot failure' })
      else this.emit({ type: 'ready' })
      return
    }
    if (msg.type === 'parse') {
      if (behavior === 'wedge') return // never reply — simulates a hung parse
      this.emit({ type: 'result', id: msg.id, doc: DOC })
    }
  }

  addEventListener(type: 'message' | 'error', listener: any) {
    if (type === 'message') this.messageListeners.push(listener)
    else if (type === 'error') this.errorListeners.push(listener)
  }

  terminate() {
    this.terminated = true
  }

  protected emit(reply: OfficeWorkerReply) {
    for (const l of this.messageListeners) l({ data: reply } as MessageEvent<OfficeWorkerReply>)
  }

  /** Simulates the worker's global scope throwing — e.g. an OOM or an
   * uncaught exception mid-parse — which fires `error`, never `message`. */
  crash(message: string) {
    for (const l of this.errorListeners) l({ message } as ErrorEvent)
  }
}

describe('OfficeEngine', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('boots and returns a parsed doc through a normal round trip', async () => {
    const engine = new OfficeEngine(() => new FakeWorker(() => 'ok'))
    const doc = await engine.parse(new Uint8Array([1, 2, 3]), 'a.docx', '')
    expect(doc).toEqual(DOC)
  })

  it('queues a second call behind the first — no message is posted for it until the first settles', async () => {
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let worker: GatedWorker | undefined
    // Gates only the FIRST 'parse' message this (singleton) worker ever
    // receives, deferring its reply until the test releases the gate. A
    // second 'parse' message reaching the worker at all — gated or not —
    // would already prove the queue failed to serialize the two calls, so
    // this only needs to hold up the first reply, not intercept the second.
    class GatedWorker extends FakeWorker {
      parseCount = 0
      protected reply(msg: OfficeWorkerRequest) {
        if (msg.type === 'parse') {
          this.parseCount++
          if (this.parseCount === 1) {
            gate.then(() => super.reply(msg))
            return
          }
        }
        super.reply(msg)
      }
    }
    const engine = new OfficeEngine(() => {
      worker = new GatedWorker(() => 'ok')
      return worker
    })

    const p1 = engine.parse(new Uint8Array([1]), 'first.docx', '')
    // Let the boot handshake + first parse message actually post.
    await vi.waitFor(() => expect(worker!.posted.some((m) => m.type === 'parse')).toBe(true))

    const p2 = engine.parse(new Uint8Array([2]), 'second.docx', '')
    // Give p2's queue-await a few microtask turns; it must NOT have posted a
    // 'parse' message yet, because the engine only ever runs one worker and
    // call #1 hasn't released the turn.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(worker!.posted.filter((m) => m.type === 'parse')).toHaveLength(1)

    releaseFirst()
    await expect(p1).resolves.toEqual(DOC)
    await expect(p2).resolves.toEqual(DOC)
    expect(worker!.posted.filter((m) => m.type === 'parse')).toHaveLength(2)
  })

  it('a parse that never returns is killed by the timeout, and the engine recovers for the next call', async () => {
    vi.useFakeTimers()
    let behavior: Behavior = 'wedge'
    const instances: FakeWorker[] = []
    const engine = new OfficeEngine(() => {
      const w = new FakeWorker(() => behavior)
      instances.push(w)
      return w
    })

    const wedged = engine.parse(new Uint8Array([1]), 'stuck.docx', '')
    // Attach the rejection assertion NOW, synchronously, rather than after
    // advancing timers below — otherwise `wedged` can reject before anything
    // has a handler attached, which Node reports as an (eventually-handled,
    // but noisy) unhandled rejection.
    const assertion = expect(wedged).rejects.toThrow(/stopped responding/)
    // Let the boot + parse message post before advancing time.
    await vi.advanceTimersByTimeAsync(0)
    // Exceed PARSE_TIMEOUT_MS (60s) — the round trip must reject and the
    // worker must be torn down rather than hang forever.
    await vi.advanceTimersByTimeAsync(61_000)
    await assertion
    expect(instances[0].terminated).toBe(true)

    // Recovery: the NEXT call must spin up a fresh worker and succeed, not
    // inherit the wedged one or stay permanently broken.
    behavior = 'ok'
    const recovered = await engine.parse(new Uint8Array([2]), 'ok.docx', '')
    expect(recovered).toEqual(DOC)
    expect(instances.length).toBe(2)
    expect(instances[1]).not.toBe(instances[0])
  })

  // REGRESSION: an earlier version's worker 'error' listener only ever
  // checked `onReady`, which is nulled right after boot completes — so a
  // crash DURING a parse (not boot) silently did nothing, and the caller sat
  // blind until the full 60s PARSE_TIMEOUT_MS elapsed even though the worker
  // was already gone. The fix keeps the listener live for the worker's whole
  // life and rejects in-flight work immediately on 'error'.
  it('a worker crash mid-parse rejects immediately, without waiting for the timeout', async () => {
    vi.useFakeTimers()
    let behavior: Behavior = 'wedge' // never replies to 'parse' on its own
    let worker: FakeWorker | undefined
    const instances: FakeWorker[] = []
    const engine = new OfficeEngine(() => {
      worker = new FakeWorker(() => behavior)
      instances.push(worker)
      return worker
    })

    const crashed = engine.parse(new Uint8Array([1]), 'crashing.docx', '')
    // The real ErrorEvent's own message ("simulated OOM") is used verbatim
    // when present — the /crashed/ fallback text only applies when the
    // browser's ErrorEvent carries no message at all.
    const assertion = expect(crashed).rejects.toThrow(/simulated OOM/)
    await vi.advanceTimersByTimeAsync(0) // let boot + the parse message post

    // Fire the crash well before PARSE_TIMEOUT_MS (60s) would ever elapse.
    worker!.crash('simulated OOM')
    await assertion
    expect(instances[0].terminated).toBe(true)

    // Recovery: the engine must still be usable afterward, same as the
    // wedge/timeout case above.
    behavior = 'ok'
    const doc = await engine.parse(new Uint8Array([2]), 'ok.docx', '')
    expect(doc).toEqual(DOC)
    expect(instances.length).toBe(2)
  })

  it('a boot failure rejects the call and a later call can still succeed', async () => {
    let behavior: Behavior = 'boot-fail'
    const engine = new OfficeEngine(() => new FakeWorker(() => behavior))

    await expect(engine.parse(new Uint8Array([1]), 'a.docx', '')).rejects.toThrow(/simulated boot failure/)

    behavior = 'ok'
    const doc = await engine.parse(new Uint8Array([2]), 'b.docx', '')
    expect(doc).toEqual(DOC)
  })

  it('copies bytes before transferring them, so the caller Uint8Array survives', async () => {
    const engine = new OfficeEngine(() => new FakeWorker(() => 'ok'))
    const original = new Uint8Array([9, 9, 9])
    await engine.parse(original, 'a.docx', '')
    expect(Array.from(original)).toEqual([9, 9, 9])
  })
})
