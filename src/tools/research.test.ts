import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createResearchTools } from './research'
import { createNotebook } from '../agent/notebook'
import { runBrowseSession, type BrowseBroker } from '../agent/browseAgent'
import { searchDuckDuckGo, fetchReadable } from '../platform/webFetch'
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

// searchDuckDuckGo/fetchReadable both do a real fetch() — replace just those two
// with controllable spies so the Task 8 scope tests below never touch the network,
// while isFetchableUrl/PDF_CONTENT (also imported by research.ts) stay real: they
// are pure and cheap, and keeping them real is what proves the scope check runs
// BEFORE research.ts's own SSRF-guarded fetch path, not instead of it.
vi.mock('../platform/webFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/webFetch')>()
  return { ...actual, searchDuckDuckGo: vi.fn(), fetchReadable: vi.fn() }
})

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

// Task 8: the launch card's source scope, enforced at three points. scopeAllows
// itself is exhaustively covered by browsePolicy.test.ts (Task 2) — what's under
// test here is that research.ts actually WIRES `sites` into it at the right
// places, with the right defaults. mockReset (not mockClear) in beforeEach so a
// test that forgets to configure searchDuckDuckGo/fetchReadable fails LOUDLY
// (undefined response -> a thrown TypeError) rather than silently inheriting a
// previous test's resolved value.
describe('source scope enforcement (Task 8)', () => {
  beforeEach(() => {
    vi.mocked(searchDuckDuckGo).mockReset()
    vi.mocked(fetchReadable).mockReset()
    vi.mocked(runBrowseSession).mockClear()
  })

  it('WebSearch narrows the query with site: operators for 1-3 scoped hosts, and filters out-of-scope results from the response', async () => {
    vi.mocked(searchDuckDuckGo).mockResolvedValue({
      results: [
        { title: 'In scope', url: 'https://aftershockpc.com/a', snippet: 'x' },
        { title: 'Out of scope', url: 'https://evil.test/b', snippet: 'y' },
      ],
    })
    const tools = createResearchTools({ selected: null, notebook: createNotebook(), sites: ['aftershockpc.com'] })

    const result = await (tools.WebSearch as any).execute({ query: 'setups' }, { abortSignal: undefined })

    // The hint reaches the engine...
    expect(searchDuckDuckGo).toHaveBeenCalledWith('setups (site:aftershockpc.com)', 8, undefined)
    // ...but the filter is what actually enforces it: the out-of-scope row the
    // (mocked) engine returned anyway never reaches the caller.
    expect(result.results).toEqual([{ title: 'In scope', url: 'https://aftershockpc.com/a', snippet: 'x' }])
  })

  it('does not add a site: operator past 3 scoped hosts, but the result filter still applies', async () => {
    vi.mocked(searchDuckDuckGo).mockResolvedValue({
      results: [
        { title: 'In scope', url: 'https://d.test/x', snippet: '' },
        { title: 'Out of scope', url: 'https://not-scoped.test/y', snippet: '' },
      ],
    })
    const tools = createResearchTools({
      selected: null,
      notebook: createNotebook(),
      sites: ['a.test', 'b.test', 'c.test', 'd.test'],
    })

    const result = await (tools.WebSearch as any).execute({ query: 'q' }, { abortSignal: undefined })

    // A 4-host OR clause is exactly the "unwieldy past 3" case the query stays bare for.
    expect(searchDuckDuckGo).toHaveBeenCalledWith('q', 8, undefined)
    // The filter has no such cutoff — it enforces the full scope regardless of size.
    expect(result.results).toEqual([{ title: 'In scope', url: 'https://d.test/x', snippet: '' }])
  })

  it('leaves the query and results untouched when no scope is given (unrestricted default)', async () => {
    vi.mocked(searchDuckDuckGo).mockResolvedValue({ results: [{ title: 'Anything', url: 'https://anything.test/x', snippet: '' }] })
    const tools = createResearchTools({ selected: null, notebook: createNotebook() }) // no `sites` at all

    const result = await (tools.WebSearch as any).execute({ query: 'q' }, { abortSignal: undefined })

    expect(searchDuckDuckGo).toHaveBeenCalledWith('q', 8, undefined)
    expect(result.results).toHaveLength(1)
  })

  it('explains an all-filtered-out result set instead of returning an unexplained empty array', async () => {
    vi.mocked(searchDuckDuckGo).mockResolvedValue({ results: [{ title: 'Out', url: 'https://evil.test/z', snippet: '' }] })
    const tools = createResearchTools({ selected: null, notebook: createNotebook(), sites: ['aftershockpc.com'] })

    const result = await (tools.WebSearch as any).execute({ query: 'q' }, { abortSignal: undefined })

    expect(result.results).toEqual([])
    expect(result.note).toMatch(/aftershockpc\.com/)
  })

  it('FetchUrl refuses an out-of-scope host before any network work, naming the allowed scope', async () => {
    const tools = createResearchTools({ selected: null, notebook: createNotebook(), sites: ['aftershockpc.com'] })

    const result = await (tools.FetchUrl as any).execute({ url: 'https://evil.test/x' }, { abortSignal: undefined })

    expect(result.error).toBe('Out of scope. This research is restricted to: aftershockpc.com')
    expect(fetchReadable).not.toHaveBeenCalled()
  })

  it('FetchUrl lets an in-scope host reach the real fetch', async () => {
    vi.mocked(fetchReadable).mockResolvedValue({ url: 'https://aftershockpc.com/a', title: 't', text: 'body' })
    const tools = createResearchTools({ selected: null, notebook: createNotebook(), sites: ['aftershockpc.com'] })

    const result = await (tools.FetchUrl as any).execute({ url: 'https://aftershockpc.com/a' }, { abortSignal: undefined })

    expect(fetchReadable).toHaveBeenCalledWith('https://aftershockpc.com/a', undefined)
    expect(result.text).toBe('body')
  })

  it('BrowseSite refuses an out-of-scope host before opening a session, spending budget, or even the model-configured check', async () => {
    const budget = { remaining: 3 }
    const tools = createResearchTools({
      selected: null, // would otherwise fail first with "No model configured" — proves scope is checked first
      notebook: createNotebook(),
      browseBroker: stubBroker,
      browseBudget: budget,
      sites: ['aftershockpc.com'],
    })

    const result = await (tools.BrowseSite as any).execute(
      { url: 'https://evil.test/x', objective: 'find x' },
      { toolCallId: 'c1', abortSignal: undefined },
    )

    expect(result.error).toBe('Out of scope. This research is restricted to: aftershockpc.com')
    expect(runBrowseSession).not.toHaveBeenCalled()
    expect(budget.remaining).toBe(3)
  })

  it('BrowseSite lets an in-scope host proceed to a real session', async () => {
    const tools = createResearchTools({
      selected: { provider: fakeProvider, modelId: 'm' },
      notebook: createNotebook(),
      browseBroker: stubBroker,
      sites: ['aftershockpc.com'],
    })

    const result = await (tools.BrowseSite as any).execute(
      { url: 'https://aftershockpc.com/x', objective: 'find x' },
      { toolCallId: 'c1', abortSignal: undefined },
    )

    expect(runBrowseSession).toHaveBeenCalledTimes(1)
    expect(result.summary).toBe('ok')
  })
})
