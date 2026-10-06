import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateSiteInput, type ValidationWorker } from './webMcpValidation'
function worker(): ValidationWorker {
  return { onmessage: null, onerror: null, postMessage: vi.fn(), terminate: vi.fn() }
}
afterEach(() => vi.useRealTimers())
describe('hostile schema validation containment', () => {
  it('runs schema and arguments in a worker, then terminates it', async () => {
    const w = worker()
    const result = validateSiteInput({ type: 'object' }, {}, undefined, () => w)
    expect(w.postMessage).toHaveBeenCalledWith({ schema: { type: 'object' }, args: {} })
    w.onmessage!({ data: { valid: true } } as MessageEvent)
    expect(await result).toBe(true)
    expect(w.terminate).toHaveBeenCalledOnce()
  })
  it('terminates a hung regex or recursive schema with a host-side deadline', async () => {
    vi.useFakeTimers()
    const w = worker()
    const result = validateSiteInput({ pattern: '^(a+)+$' }, { query: 'a'.repeat(32) + '!' }, undefined, () => w)
    await vi.advanceTimersByTimeAsync(1501)
    expect(await result).toBe(false)
    expect(w.terminate).toHaveBeenCalledOnce()
  })
  it('fails closed on invalid schema, worker error, unavailable Worker, or Stop', async () => {
    const w = worker()
    const result = validateSiteInput({ $ref: '#' }, {}, undefined, () => w)
    w.onerror!({} as ErrorEvent)
    expect(await result).toBe(false)
    expect(await validateSiteInput({}, {}, undefined, () => { throw new Error('CSP') })).toBe(false)
    const controller = new AbortController(); const w2 = worker()
    const aborted = validateSiteInput({}, {}, controller.signal, () => w2)
    controller.abort()
    expect(await aborted).toBe(false)
    expect(w2.terminate).toHaveBeenCalledOnce()
  })
})
