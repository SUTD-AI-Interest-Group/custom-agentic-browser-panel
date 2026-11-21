import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DeciderEngine, type WorkerLike } from './engine'
import type { DeciderWorkerReply, DeciderWorkerRequest, DecisionResult } from './protocol'
import type { DecisionRequest } from './request'

const req = (tag = 'x'): DecisionRequest => ({ state: tag, questions: {} })
const resultFor = (tokens: number): DecisionResult => ({ answers: {}, ms: 1, tokens, backend: 'wasm', cold: false })

let workers: FakeWorker[]
let hold: boolean
class FakeWorker implements WorkerLike {
  terminated = false
  decides: { id: string; request: DecisionRequest; maxTokens?: number }[] = []
  private listeners: ((e: MessageEvent<DeciderWorkerReply>) => void)[] = []
  held = hold
  constructor() { workers.push(this) }
  addEventListener(t: 'message', l: (e: MessageEvent<DeciderWorkerReply>) => void) { if (t === 'message') this.listeners.push(l) }
  emit(data: DeciderWorkerReply) { for (const l of this.listeners) l({ data } as MessageEvent<DeciderWorkerReply>) }
  postMessage(m: DeciderWorkerRequest) {
    if (m.type === 'dispose') this.emit({ type: 'disposed' })
    else if (m.type === 'init') this.emit({ type: 'ready', backend: 'wasm', bootMs: 1 })
    else if (m.type === 'decide') {
      this.decides.push('maxTokens' in m ? { id: m.id, request: m.request, maxTokens: m.maxTokens } : { id: m.id, request: m.request })
      if (!this.held) this.emit({ type: 'result', id: m.id, result: resultFor(1) })
    }
  }
  terminate() { this.terminated = true }
}

const make = (o: ConstructorParameters<typeof DeciderEngine>[0] = {}) =>
  new DeciderEngine({ spawn: () => new FakeWorker(), ...o })

beforeEach(() => { vi.useFakeTimers(); workers = []; hold = false })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('boots once for two calls', async () => {
  const e = make()
  await e.decide(req())
  await e.decide(req())
  expect(workers).toHaveLength(1)
})

it('runs calls FIFO and starts the second timeout only when it runs', async () => {
  const e = make({ decideTimeoutMs: 1000 })
  hold = true
  const a = e.decide(req('a'))
  const b = e.decide(req('b'))
  await vi.advanceTimersByTimeAsync(900)
  expect(workers[0].decides).toHaveLength(1)
  workers[0].emit({ type: 'result', id: workers[0].decides[0].id, result: resultFor(7) })
  expect((await a)?.tokens).toBe(7)
  // b started just now; 900ms later it must still be alive (it would have timed out at 1000 from enqueue).
  await vi.advanceTimersByTimeAsync(900)
  expect(workers[0].decides).toHaveLength(2)
  workers[0].emit({ type: 'result', id: workers[0].decides[1].id, result: resultFor(8) })
  expect((await b)?.tokens).toBe(8)
})

it('a decide timeout terminates and rebuilds, rejecting only the in-flight call', async () => {
  const e = make({ decideTimeoutMs: 1000 })
  hold = true
  const a = e.decide(req('a'))
  const b = e.decide(req('b'))
  hold = false // only the first worker (already built) holds; its replacement answers
  const aRejected = expect(a).rejects.toThrow(/stopped responding/)
  await vi.advanceTimersByTimeAsync(1000)
  await aRejected
  expect(workers[0].terminated).toBe(true)
  expect((await b)?.tokens).toBe(1)
  expect(workers).toHaveLength(2)
})

it('replaces a queued dropIfBusy call with a newer one', async () => {
  const e = make()
  hold = true
  const a = e.decide(req('a'))
  await vi.advanceTimersByTimeAsync(0)
  const b = e.decide(req('b'), { dropIfBusy: true })
  const c = e.decide(req('c'), { dropIfBusy: true })
  expect(await b).toBeNull()
  workers[0].held = false
  workers[0].emit({ type: 'result', id: workers[0].decides[0].id, result: resultFor(1) })
  await a
  expect((await c)?.tokens).toBe(1)
  expect(workers[0].decides.map((d) => d.request.state)).toEqual(['a', 'c'])
})

it('a dropIfBusy call runs immediately when idle', async () => {
  const e = make()
  expect((await e.decide(req(), { dropIfBusy: true }))?.tokens).toBe(1)
})

it('terminates the worker after idleMs and rebuilds on demand', async () => {
  const e = make({ idleMs: 5000 })
  await e.decide(req())
  await vi.advanceTimersByTimeAsync(4900)
  expect(workers[0].terminated).toBe(false)
  await vi.advanceTimersByTimeAsync(200)
  expect(workers[0].terminated).toBe(true)
  await e.decide(req())
  expect(workers).toHaveLength(2)
})

it('rejects a boot failure and recovers on the next call', async () => {
  let n = 0
  const e = new DeciderEngine({
    spawn: () => {
      const w = new FakeWorker()
      if (n++ === 0) w.postMessage = (m) => { if (m.type === 'init') w.emit({ type: 'boot-failed', message: 'no model' }) }
      return w
    },
  })
  await expect(e.decide(req())).rejects.toThrow('no model')
  expect((await e.decide(req()))?.tokens).toBe(1)
})

it('a worker-reported failure rejects just that call', async () => {
  const e = make()
  hold = true
  const a = e.decide(req())
  await vi.advanceTimersByTimeAsync(0)
  const rejected = expect(a).rejects.toThrow('too-long')
  workers[0].emit({ type: 'failed', id: workers[0].decides[0].id, message: 'too-long' })
  await rejected
  expect(workers[0].terminated).toBe(false)
})

it('dispose waits for the worker to release, then terminates', async () => {
  const e = make()
  await e.decide(req())
  await e.dispose()
  expect(workers[0].terminated).toBe(true)
})

it('dispose terminates after 2s when the worker never replies', async () => {
  const e = make()
  await e.decide(req())
  workers[0].postMessage = () => {}
  const d = e.dispose()
  await vi.advanceTimersByTimeAsync(1900)
  expect(workers[0].terminated).toBe(false)
  await vi.advanceTimersByTimeAsync(200)
  await d
  expect(workers[0].terminated).toBe(true)
})

it('two concurrent decides before boot share one boot', async () => {
  const e = make()
  const [a, b] = await Promise.all([e.decide(req('a')), e.decide(req('b'))])
  expect(a?.tokens).toBe(1)
  expect(b?.tokens).toBe(1)
  expect(workers).toHaveLength(1)
})

it('dispose during boot settles the waiting call, and a later boot is not killed by the stale timer', async () => {
  let first = true
  const e = new DeciderEngine({
    bootTimeoutMs: 1000,
    spawn: () => {
      const w = new FakeWorker()
      if (first) {
        first = false
        w.postMessage = (m) => { if (m.type === 'dispose') w.emit({ type: 'disposed' }) }
      }
      return w
    },
  })
  const a = e.decide(req('a'))
  const aRejected = expect(a).rejects.toThrow(/disposed/)
  await vi.advanceTimersByTimeAsync(0)
  await e.dispose()
  await aRejected
  await e.warm()
  expect(workers).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(2000)
  expect(workers[1].terminated).toBe(false)
  expect((await e.decide(req('b')))?.tokens).toBe(1)
})

it('forwards a caller cap (driver mode\'s dense-page cap) to the worker, and sends none otherwise', async () => {
  const e = make()
  await e.decide(req('capped'), { maxTokens: 2500 })
  await e.decide(req('plain'))
  await e.decide(req('shadow'), { dropIfBusy: true })
  expect(workers[0].decides.map((d) => [d.request.state, d.maxTokens])).toEqual([['capped', 2500], ['plain', undefined], ['shadow', undefined]])
  expect(workers[0].decides.slice(1).every((d) => !('maxTokens' in d))).toBe(true)
})
