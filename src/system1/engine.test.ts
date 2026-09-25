// Tests the health-cooldown / error-handling POLICY in System1Engine against a
// fake Worker and a stubbed Cache Storage — there is no browser Worker,
// chrome.runtime, or `caches` global under Vitest, which is exactly why
// System1Engine takes an injectable `spawnWorker` (see its own comment,
// mirroring OfficeEngine's identical precedent in
// src/platform/officeEngine.test.ts). The real inference path (worker.ts) and
// the real worker round-trip are out of scope here by design — no direct
// engine test existed before this fix round either, matching pdfEngine.ts's
// established precedent — this file exists specifically to cover the health
// cooldown and post-boot crash handling added in this fix round.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { System1Engine, type WorkerLike } from './engine'
import { fileUrl, WEIGHTS_PIN, type WeightsManifest } from './weights'
import type { DecideRequest, DecideResult, System1WorkerReply, System1WorkerRequest } from './protocol'

const MANIFEST: WeightsManifest = {
  format: 1,
  model: 'von-test',
  variant: 'q4',
  files: [{ path: 'model_q4.onnx', bytes: 1, sha256: 'a'.repeat(64) }],
}
const REQ: DecideRequest = { state: 's', questions: { q: { instructions: 'i', options: { a: 'A', b: 'B' } } } }
const RESULT: DecideResult = { answers: { q: { choice: 'a', probabilities: { a: 1, b: 0 }, top: 1, confidence: 1 } }, ms: 1 }

/** Stubs the global Cache Storage `boot()` reads its manifest from. */
function stubCaches() {
  const manifestUrl = fileUrl(WEIGHTS_PIN, 'manifest.json')
  const match = vi.fn(async (url: string) => (url === manifestUrl ? new Response(JSON.stringify(MANIFEST)) : undefined))
  vi.stubGlobal('caches', { open: vi.fn(async () => ({ match })) })
}

type Behavior = 'ok' | 'wedge' | 'boot-fail'

/** A controllable fake Worker. `behavior` is read at postMessage-time, so a
 * test can swap it between calls without needing a new factory per case. */
class FakeWorker implements WorkerLike {
  posted: System1WorkerRequest[] = []
  terminated = false
  private messageListeners: ((e: MessageEvent<System1WorkerReply>) => void)[] = []
  private errorListeners: ((e: ErrorEvent) => void)[] = []

  constructor(private behavior: () => Behavior) {}

  postMessage(msg: System1WorkerRequest) {
    this.posted.push(msg)
    this.reply(msg)
  }

  private reply(msg: System1WorkerRequest) {
    const behavior = this.behavior()
    if (msg.type === 'init') {
      if (behavior === 'boot-fail') this.emit({ type: 'boot-failed', message: 'simulated boot failure' })
      else this.emit({ type: 'ready' })
      return
    }
    if (msg.type === 'decide') {
      if (behavior === 'wedge') return // never reply — simulates a hung/crashed-before-reply decide
      this.emit({ type: 'result', id: msg.id, result: RESULT })
    }
  }

  addEventListener(type: 'message' | 'error', listener: any) {
    if (type === 'message') this.messageListeners.push(listener)
    else this.errorListeners.push(listener)
  }

  terminate() {
    this.terminated = true
  }

  private emit(reply: System1WorkerReply) {
    for (const l of this.messageListeners) l({ data: reply } as MessageEvent<System1WorkerReply>)
  }

  /** Simulates the worker's global scope throwing after boot — fires `error`, never `message`. */
  crash(message: string) {
    for (const l of this.errorListeners) l({ message } as ErrorEvent)
  }
}

describe('System1Engine', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('goes unhealthy after a decide timeout, and recovers once the cooldown elapses', async () => {
    vi.useFakeTimers()
    stubCaches()
    const engine = new System1Engine(() => new FakeWorker(() => 'wedge'))

    const wedged = engine.decide(REQ)
    // Attach the rejection assertion synchronously, before advancing timers,
    // so it isn't an unhandled rejection in the window before it's attached.
    const assertion = expect(wedged).rejects.toThrow(/stopped responding/)
    await vi.advanceTimersByTimeAsync(0) // let boot + the decide message post
    expect(engine.healthy).toBe(true) // nothing has failed yet

    await vi.advanceTimersByTimeAsync(15_000) // DECIDE_TIMEOUT_MS
    await assertion
    expect(engine.healthy).toBe(false)

    await vi.advanceTimersByTimeAsync(59_000) // short of HEALTH_COOLDOWN_MS (60s)
    expect(engine.healthy).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000) // crosses HEALTH_COOLDOWN_MS
    expect(engine.healthy).toBe(true)
  })

  it('a post-boot worker crash rejects the in-flight decide immediately, without waiting for its timeout', async () => {
    vi.useFakeTimers()
    stubCaches()
    let worker: FakeWorker | undefined
    const engine = new System1Engine(() => {
      worker = new FakeWorker(() => 'wedge') // never auto-replies to 'decide'
      return worker
    })

    const crashed = engine.decide(REQ)
    const assertion = expect(crashed).rejects.toThrow(/torn down/)
    await vi.advanceTimersByTimeAsync(0) // let boot + the decide message post
    expect(engine.healthy).toBe(true)

    // Fire well before DECIDE_TIMEOUT_MS (15s) would ever elapse.
    worker!.crash('simulated GPU process crash')
    await assertion
    expect(worker!.terminated).toBe(true)
    expect(engine.healthy).toBe(false)
  })

  it('dispose() terminates the worker, rejects the in-flight decide and reboots fresh next time, without going unhealthy', async () => {
    vi.useFakeTimers()
    stubCaches()
    const workers: FakeWorker[] = []
    let behavior: Behavior = 'wedge'
    const engine = new System1Engine(() => {
      const w = new FakeWorker(() => behavior)
      workers.push(w)
      return w
    })

    const inFlight = engine.decide(REQ)
    const assertion = expect(inFlight).rejects.toThrow(/torn down/)
    await vi.advanceTimersByTimeAsync(0)
    engine.dispose()
    await assertion
    expect(workers[0].terminated).toBe(true)
    expect(engine.healthy).toBe(true)

    behavior = 'ok'
    await expect(engine.decide(REQ)).resolves.toEqual(RESULT)
    expect(workers).toHaveLength(2)
  })

  it('dispose() during boot neither spawns a worker afterwards nor marks the engine unhealthy', async () => {
    // Hold boot at its manifest read so dispose() lands mid-boot.
    let openCache!: () => void
    const manifestUrl = fileUrl(WEIGHTS_PIN, 'manifest.json')
    const match = async (url: string) => (url === manifestUrl ? new Response(JSON.stringify(MANIFEST)) : undefined)
    vi.stubGlobal('caches', { open: () => new Promise((r) => { openCache = () => r({ match }) }) })
    const spawn = vi.fn(() => new FakeWorker(() => 'ok'))
    const engine = new System1Engine(spawn)
    const booting = engine.decide(REQ)
    const assertion = expect(booting).rejects.toThrow(/shut down/)
    await vi.waitFor(() => expect(openCache).toBeDefined())
    engine.dispose()
    openCache()
    await assertion
    expect(spawn).not.toHaveBeenCalled()
    expect(engine.healthy).toBe(true)
  })

  it("ignores an error event from a worker it has already replaced", async () => {
    vi.useFakeTimers()
    stubCaches()
    const workers: FakeWorker[] = []
    const engine = new System1Engine(() => {
      const w = new FakeWorker(() => 'ok')
      workers.push(w)
      return w
    })
    await engine.decide(REQ)
    engine.dispose()
    await engine.decide(REQ) // boots workers[1]
    workers[0].crash('late error from the old worker')
    expect(engine.healthy).toBe(true)
    expect(workers[1].terminated).toBe(false)
    await expect(engine.decide(REQ)).resolves.toEqual(RESULT)
  })
})
