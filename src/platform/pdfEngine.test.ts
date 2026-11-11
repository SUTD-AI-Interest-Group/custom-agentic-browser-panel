import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PdfEngine } from './pdfEngine'
import type { ExtractResult } from './pdfExtract'

const result: ExtractResult = { pdfType: 'TextBased', markdown: 'Hello', pageCount: 1, title: '', pagesNeedingOcr: [], hasEncodingIssues: false }
let workers: FakeWorker[]
let hold: boolean
class FakeWorker extends EventTarget {
  terminated = false
  constructor() { super(); workers.push(this) }
  postMessage(message: { type: string; id?: string }) {
    if (message.type === 'init') this.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' } }))
    else if (!hold) this.dispatchEvent(new MessageEvent('message', { data: { type: 'result', id: message.id, result } }))
  }
  terminate() { this.terminated = true }
}
beforeEach(() => {
  vi.useFakeTimers()
  workers = []; hold = false
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('chrome', { runtime: { getURL: (file: string) => file } })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('releases the worker after inactivity and restarts for the next document', async () => {
  const engine = new PdfEngine()
  const bytes = new Uint8Array([1, 2])
  expect(await engine.extract(bytes)).toEqual(result)
  await vi.advanceTimersByTimeAsync(29_000)
  expect(workers[0].terminated).toBe(false)
  expect(await engine.extract(bytes)).toEqual(result)
  await vi.advanceTimersByTimeAsync(29_000)
  expect(workers[0].terminated).toBe(false)
  await vi.advanceTimersByTimeAsync(1000)
  expect(workers[0].terminated).toBe(true)
  expect(await engine.extract(bytes)).toEqual(result)
  expect(workers).toHaveLength(2)
  expect([...bytes]).toEqual([1, 2])
})

it('rejects a crashed extraction immediately and recovers without waiting for a timeout', async () => {
  const engine = new PdfEngine()
  hold = true
  const extraction = engine.extract(new Uint8Array([1]))
  const rejected = expect(extraction).rejects.toThrow('simulated crash')
  await vi.advanceTimersByTimeAsync(0)
  workers[0].dispatchEvent(new ErrorEvent('error', { message: 'simulated crash' }))
  await rejected
  expect(workers[0].terminated).toBe(true)
  hold = false
  expect(await engine.extract(new Uint8Array([2]))).toEqual(result)
  expect(workers).toHaveLength(2)
})
