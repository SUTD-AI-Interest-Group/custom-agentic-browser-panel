import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { LangfuseIngestionClient, testLangfuseConnection } from './langfuseClient'

// Zero coverage existed for this file before this hardening pass (d14's own
// audit note). Three gaps called out explicitly:
//  1. The file's own CRITICAL comment: Langfuse answers input errors with
//     207 + a per-event `errors` list, NOT a 4xx — so `res.ok` alone proves
//     nothing. Nothing exercised the errors-array branch at all.
//  2. `flush()`'s fetch had no timeout — an unreachable/slow host could hang
//     an awaited flush (dream.ts's "Dream now") indefinitely (d14 F4).
//  3. `flush()` had no reentrancy guard — a slow host plus enough enqueue
//     traffic to cross the eager-flush threshold twice could run two fully
//     concurrent POSTs with no cap (d14 F6).

let fetchMock: ReturnType<typeof vi.fn>
let warnSpy: ReturnType<typeof vi.spyOn>
let infoSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fetchMock = vi.fn()
  globalThis.fetch = fetchMock as unknown as typeof fetch
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  infoSpy.mockRestore()
})

function okResponse(body: unknown, status = 207) {
  return { ok: true, status, json: async () => body }
}

// --- CRITICAL: 207 + errors is a rejection, not a success -------------------

test('flush() treats a 207 response with a non-empty errors array as a rejection, not a success', async () => {
  fetchMock.mockResolvedValue(okResponse({ errors: [{ status: 400, message: 'invalid event' }] }))
  const client = new LangfuseIngestionClient('https://lf.example.com', 'pk', 'sk')
  client.enqueue('trace-create', { id: '1' })
  await client.flush()

  expect(warnSpy).toHaveBeenCalled()
  const warnedText = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]) + ' ' + JSON.stringify(c[1] ?? '')).join('\n')
  expect(warnedText).toContain('REJECTED')
  // Must NOT be logged as a success.
  expect(infoSpy).not.toHaveBeenCalled()
})

test('flush() logs success only when the errors array is genuinely empty', async () => {
  fetchMock.mockResolvedValue(okResponse({ errors: [] }))
  const client = new LangfuseIngestionClient('https://lf.example.com', 'pk', 'sk')
  client.enqueue('trace-create', { id: '1' })
  await client.flush()

  expect(infoSpy).toHaveBeenCalled()
  expect(warnSpy).not.toHaveBeenCalled()
})

test('flush() warns (not throws) on a non-2xx HTTP status', async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
  const client = new LangfuseIngestionClient('https://lf.example.com', 'pk', 'sk')
  client.enqueue('trace-create', { id: '1' })
  await expect(client.flush()).resolves.toBeUndefined()
  expect(warnSpy).toHaveBeenCalled()
})

test('flush() warns (not throws) when fetch itself rejects (network/CORS down)', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
  const client = new LangfuseIngestionClient('https://lf.example.com', 'pk', 'sk')
  client.enqueue('trace-create', { id: '1' })
  await expect(client.flush()).resolves.toBeUndefined()
  expect(warnSpy).toHaveBeenCalled()
})

// --- F4: bounded timeout -----------------------------------------------------

test('flush() gives up after its own timeout instead of hanging forever', async () => {
  // A fetch that never resolves on its own — only settles if its AbortSignal
  // fires, mirroring real fetch()'s behavior under an aborted signal.
  fetchMock.mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
  })
  // A tiny timeout (ctor's 4th, test-only parameter) keeps this test fast
  // and independent of fake-timer support for the platform AbortSignal.timeout.
  const client = new LangfuseIngestionClient('https://lf.example.com', 'pk', 'sk', 30)
  client.enqueue('trace-create', { id: '1' })
  await expect(client.flush()).resolves.toBeUndefined()
  expect(warnSpy).toHaveBeenCalled()
})

// --- F6: reentrancy / serialization ------------------------------------------

test('overlapping flush() calls are serialized, not run as concurrent requests', async () => {
  let concurrent = 0
  let maxConcurrent = 0
  const releases: Array<() => void> = []
  fetchMock.mockImplementation(() => {
    concurrent += 1
    maxConcurrent = Math.max(maxConcurrent, concurrent)
    return new Promise((resolve) => {
      releases.push(() => {
        concurrent -= 1
        resolve(okResponse({ errors: [] }))
      })
    })
  })
  const client = new LangfuseIngestionClient('https://lf.example.com', 'pk', 'sk')
  client.enqueue('trace-create', { id: '1' })
  const first = client.flush()

  // Let the first doFlush() actually reach its fetch() call (and splice the
  // queue) before adding a second event — otherwise both enqueues land in
  // the SAME batch, which would make this assertion vacuous rather than a
  // real test of serialization.
  for (let i = 0; i < 10 && fetchMock.mock.calls.length < 1; i++) await Promise.resolve()
  expect(fetchMock).toHaveBeenCalledTimes(1)

  client.enqueue('trace-create', { id: '2' })
  const second = client.flush()

  // Give the second call every chance to start a concurrent fetch if the
  // implementation doesn't serialize.
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(maxConcurrent).toBe(1)
  expect(fetchMock).toHaveBeenCalledTimes(1) // second flush is still queued behind the first

  releases[0]()
  await first
  for (let i = 0; i < 10 && fetchMock.mock.calls.length < 2; i++) await Promise.resolve()
  expect(fetchMock).toHaveBeenCalledTimes(2)

  releases[1]()
  await second
})

// --- testLangfuseConnection (previously untested) ---------------------------

test('testLangfuseConnection reports auth failure distinctly on 401/403', async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) })
  const result = await testLangfuseConnection('https://lf.example.com', 'pk', 'sk')
  expect(result.ok).toBe(false)
  expect(result.message).toMatch(/auth/i)
})

test('testLangfuseConnection reports a 207-with-errors test event as a failure, not a false success', async () => {
  fetchMock.mockResolvedValue(okResponse({ errors: [{ status: 400, message: 'bad test event' }] }))
  const result = await testLangfuseConnection('https://lf.example.com', 'pk', 'sk')
  expect(result.ok).toBe(false)
  expect(result.message).toContain('bad test event')
})

test('testLangfuseConnection reports success when Langfuse genuinely accepts the event', async () => {
  fetchMock.mockResolvedValue(okResponse({ errors: [] }))
  const result = await testLangfuseConnection('https://lf.example.com', 'pk', 'sk')
  expect(result.ok).toBe(true)
})

test('testLangfuseConnection never throws on a network failure', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
  const result = await testLangfuseConnection('https://lf.example.com', 'pk', 'sk')
  expect(result.ok).toBe(false)
})
