import { beforeEach, expect, test, vi } from 'vitest'
import { getObserver, instrumentToolset, mapUsage, sanitize } from './index'
import type { ObservabilityConfig } from '../../data/settings'

// A fresh fetch mock per test; different keys per test give each getObserver()
// call a distinct live observer (keyed by config signature), so buffers/flushes
// don't leak across tests.
let fetchMock: ReturnType<typeof vi.fn>
let keySeq = 0
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 207 })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  keySeq += 1
})

function cfg(over: Partial<ObservabilityConfig> = {}): ObservabilityConfig {
  return {
    enabled: true,
    publicKey: `pk-test-${keySeq}`,
    secretKey: `sk-test-${keySeq}`,
    host: 'https://lf.example.com',
    captureContent: true,
    captureScreenshots: false,
    ...over,
  }
}

/** Flatten every event across all POSTed batches. */
function postedEvents(): Array<{ type: string; body: any }> {
  return fetchMock.mock.calls.flatMap(([, init]: any) => JSON.parse(init.body).batch)
}

// --- mapUsage -------------------------------------------------------------

test('mapUsage maps AI SDK usage to Langfuse usageDetails', () => {
  expect(mapUsage(undefined)).toBeUndefined()
  expect(mapUsage({})).toBeUndefined()
  expect(mapUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })).toEqual({
    input: 10,
    output: 5,
    total: 15,
  })
  expect(mapUsage({ inputTokens: 3, reasoningTokens: 2, cachedInputTokens: 1 })).toEqual({
    input: 3,
    reasoning: 2,
    cache_read: 1,
  })
})

// --- sanitize -------------------------------------------------------------

test('sanitize strips images unless kept, and caps long strings', () => {
  const img = 'data:image/png;base64,QUJD'
  expect(sanitize(img, false)).toBe('[image omitted]')
  expect(sanitize(img, true)).toBe(img)

  const long = 'x'.repeat(250_000)
  expect((sanitize(long, true) as string).endsWith('…[truncated]')).toBe(true)
  expect((sanitize(long, true) as string).length).toBeLessThan(long.length)

  // Walks nested structures.
  const nested = sanitize({ a: [{ b: img }], c: 'ok' }, false) as any
  expect(nested.a[0].b).toBe('[image omitted]')
  expect(nested.c).toBe('ok')
})

// --- disabled path (no-op) ------------------------------------------------

test('disabled observer emits nothing and never hits the network', async () => {
  const obs = getObserver(cfg({ enabled: false }))
  expect(obs.enabled).toBe(false)
  const trace = obs.startTrace({ name: 't', sessionId: 's' })
  const gen = trace.generation({ name: 'g', input: 'hi' })
  gen.end({ output: 'yo', usage: { inputTokens: 1, outputTokens: 1 } })
  trace.span({ name: 'tool:X', input: {} }).end({ output: {} })
  trace.end({ output: 'done' })
  await obs.flush()
  expect(fetchMock).not.toHaveBeenCalled()
})

test('missing keys fall back to the no-op observer', () => {
  expect(getObserver(cfg({ publicKey: '' })).enabled).toBe(false)
  expect(getObserver(cfg({ secretKey: '' })).enabled).toBe(false)
  expect(getObserver(cfg({ host: '' })).enabled).toBe(false)
})

// --- live path ------------------------------------------------------------

test('enabled observer batches a trace + generation with usage and auth', async () => {
  const obs = getObserver(cfg())
  expect(obs.enabled).toBe(true)
  const trace = obs.startTrace({ name: 'chat turn', sessionId: 'conv-1', input: 'hello', tags: ['chat'] })
  const gen = trace.generation({ name: 'step-1', model: 'gpt-x', input: 'hello' })
  gen.end({ output: 'hi there', usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 }, finishReason: 'stop' })
  trace.end({ output: 'hi there' })
  await obs.flush()

  expect(fetchMock).toHaveBeenCalled()
  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe('https://lf.example.com/api/public/ingestion')
  expect((init.headers as any).Authorization).toMatch(/^Basic /)

  const events = postedEvents()
  const traceCreate = events.find((e) => e.type === 'trace-create')
  expect(traceCreate?.body.sessionId).toBe('conv-1')
  expect(traceCreate?.body.tags).toEqual(['chat'])
  expect(traceCreate?.body.input).toBe('hello')

  const genUpdate = events.find((e) => e.type === 'generation-update')
  expect(genUpdate?.body.usageDetails).toEqual({ input: 12, output: 4, total: 16 })
  expect(genUpdate?.body.output).toBe('hi there')
  expect(genUpdate?.body.metadata?.finishReason).toBe('stop')
})

test('captureContent=false drops content but keeps token metadata', async () => {
  const obs = getObserver(cfg({ captureContent: false }))
  const trace = obs.startTrace({ name: 'turn', input: 'secret prompt' })
  const gen = trace.generation({ name: 'step-1', model: 'm', input: 'secret prompt' })
  gen.end({ output: 'secret answer', usage: { inputTokens: 9, outputTokens: 3 } })
  await obs.flush()

  const events = postedEvents()
  const traceCreate = events.find((e) => e.type === 'trace-create')
  expect(traceCreate?.body.input).toBeUndefined()
  const genCreate = events.find((e) => e.type === 'generation-create')
  expect(genCreate?.body.input).toBeUndefined()
  const genUpdate = events.find((e) => e.type === 'generation-update')
  expect(genUpdate?.body.output).toBeUndefined()
  // Tokens survive redaction.
  expect(genUpdate?.body.usageDetails).toEqual({ input: 9, output: 3 })
})

// --- instrumentToolset ----------------------------------------------------

test('instrumentToolset records a span per tool call with the approval outcome', async () => {
  const obs = getObserver(cfg())
  const trace = obs.startTrace({ name: 'turn' })

  const tools: any = {
    Allowed: { execute: async (input: any) => ({ ok: true, echo: input.q }) },
    Denied: { execute: async () => ({ denied: true, message: 'no' }) },
  }
  instrumentToolset(tools, trace)

  const out = await tools.Allowed.execute({ q: 42 }, {})
  expect(out).toEqual({ ok: true, echo: 42 })
  await tools.Denied.execute({}, {})
  await obs.flush()

  const events = postedEvents()
  const spanCreates = events.filter((e) => e.type === 'span-create')
  expect(spanCreates.map((e) => e.body.name).sort()).toEqual(['tool:Allowed', 'tool:Denied'])

  const spanUpdates = events.filter((e) => e.type === 'span-update')
  // Two spans updated; one approved, one denied.
  const approvedFlags = spanUpdates.map((e) => e.body.metadata?.approved).sort()
  expect(approvedFlags).toEqual([false, true])
})

test('a throwing tool ends its span as an error and rethrows', async () => {
  const obs = getObserver(cfg())
  const trace = obs.startTrace({ name: 'turn' })
  const tools: any = {
    Boom: {
      execute: async () => {
        throw new Error('kaboom')
      },
    },
  }
  instrumentToolset(tools, trace)
  await expect(tools.Boom.execute({}, {})).rejects.toThrow('kaboom')
  await obs.flush()

  const spanUpdate = postedEvents().find((e) => e.type === 'span-update')
  expect(spanUpdate?.body.level).toBe('ERROR')
  expect(spanUpdate?.body.statusMessage).toContain('kaboom')
})
