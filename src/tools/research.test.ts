import { describe, it, expect, vi } from 'vitest'
import { createResearchTools } from './research'
import { createNotebook } from '../agent/notebook'
import type { BrowseBroker } from '../agent/browseAgent'
import type { ProviderConfig } from '../data/settings'

// BrowseSite's execute() constructs a real model via createModel() before handing
// off to runBrowseSession — mock both of createResearchTools's own model-touching
// collaborators so this file only exercises the SIGNAL-SELECTION logic under test
// (tools/research.ts:369), not a real provider client or a real page walk.
vi.mock('../agent/provider', () => ({ createModel: vi.fn(() => ({ modelId: 'mock' })) }))

let capturedSignal: AbortSignal | undefined
vi.mock('../agent/browseAgent', () => ({
  runBrowseSession: vi.fn(async (opts: { signal: AbortSignal }) => {
    capturedSignal = opts.signal
    return { visited: [], digest: 'ok', findingsAdded: 0, stoppedBecause: 'done' as const }
  }),
}))

const fakeProvider: ProviderConfig = { id: 'p1', name: 'Test', baseURL: 'https://x.test', apiKey: '', models: ['m'] }

const stubBroker: BrowseBroker = {
  async step() {
    return { ok: true, message: 'ok' }
  },
}

describe('BrowseSite abort-signal wiring (F4 — HIGH)', () => {
  it('honors its own per-call abortSignal even when the task-level signal never aborts', async () => {
    capturedSignal = undefined
    const taskCtrl = new AbortController() // the task-level signal — never aborted here
    const attemptCtrl = new AbortController()
    attemptCtrl.abort() // simulates resilient()'s 900s per-attempt timeout already firing

    const tools = createResearchTools({
      selected: { provider: fakeProvider, modelId: 'm' },
      notebook: createNotebook(),
      browseBroker: stubBroker,
      signal: taskCtrl.signal,
    })

    await (tools.BrowseSite as any).execute(
      { url: 'https://site.test', objective: 'find x' },
      { toolCallId: 'c1', abortSignal: attemptCtrl.signal },
    )

    expect(capturedSignal).toBeDefined()
    // Must reflect the per-call abort, not just the (never-aborted) task signal.
    expect(capturedSignal!.aborted).toBe(true)
  })

  it('still ends the session promptly when only the TASK-level signal aborts (a real Stop)', async () => {
    capturedSignal = undefined
    const taskCtrl = new AbortController()
    const attemptCtrl = new AbortController() // never aborted — the round is still within its timeout

    const tools = createResearchTools({
      selected: { provider: fakeProvider, modelId: 'm' },
      notebook: createNotebook(),
      browseBroker: stubBroker,
      signal: taskCtrl.signal,
    })

    taskCtrl.abort() // a user Stop

    await (tools.BrowseSite as any).execute(
      { url: 'https://site.test', objective: 'find x' },
      { toolCallId: 'c1', abortSignal: attemptCtrl.signal },
    )

    expect(capturedSignal).toBeDefined()
    expect(capturedSignal!.aborted).toBe(true)
  })
})

describe('WriteNotebook claim/quote length cap (F3 secondary — HIGH)', () => {
  it('rejects an oversized claim/quote instead of accepting an unbounded string', () => {
    const tools = createResearchTools({ selected: null, notebook: createNotebook() })
    const schema = (tools.WriteNotebook as any).inputSchema as { safeParse: (v: unknown) => { success: boolean } }

    const ok = schema.safeParse({ findings: [{ claim: 'short claim', sourceUrl: 'https://a.test', quote: 'short quote' }] })
    expect(ok.success).toBe(true)

    const overLong = 'x'.repeat(5_000)
    const rejected = schema.safeParse({ findings: [{ claim: overLong, sourceUrl: 'https://a.test' }] })
    expect(rejected.success).toBe(false)

    const rejectedQuote = schema.safeParse({ findings: [{ claim: 'ok', sourceUrl: 'https://a.test', quote: overLong }] })
    expect(rejectedQuote.success).toBe(false)
  })
})
