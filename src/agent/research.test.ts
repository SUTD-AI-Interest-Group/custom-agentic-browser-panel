import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runAgentTurn, type UIPart } from './agent'
import { extractStructured } from './extract'
import { createModel } from './provider'
import { createResearchTools } from '../tools/research'
import { generateText } from 'ai'
import type { ProviderConfig } from '../data/settings'

// research.ts is the whole Plan → (Gather ↔ Reflect) → Synthesize → Verify state
// machine, and until this file it had ZERO direct test coverage — exactly why the
// reflect()/planResearch() bug (F1/F2 below) went unnoticed: resilience.test.ts
// thoroughly tests withResilience's own retry loop in isolation, but nothing
// tested that research.ts's phase helpers actually let errors reach it.
//
// Strategy: mock the expensive/Chrome-adjacent collaborators (the gather turn,
// structured extraction, the toolset builder, provider construction, and
// free-text generation) so each test controls exactly one phase's behavior
// without needing a full scripted multi-turn model conversation. What's under
// test is the ORCHESTRATION — phase transitions, resilience wiring, fallbacks —
// not the model's cleverness, matching this repo's existing browseAgent.test.ts
// philosophy.

vi.mock('./agent', () => ({ runAgentTurn: vi.fn() }))
vi.mock('./extract', () => ({ extractStructured: vi.fn() }))
vi.mock('./provider', () => ({ createModel: vi.fn(() => ({ modelId: 'mock-model' })) }))
vi.mock('../tools/research', () => ({ createResearchTools: vi.fn(() => ({})) }))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: vi.fn() }
})

// Import AFTER the vi.mock calls above (vitest hoists them, so this is safe
// regardless of literal order, but writing it this way keeps intent obvious).
import { runResearch } from './research'

const mockedRunAgentTurn = vi.mocked(runAgentTurn)
const mockedExtractStructured = vi.mocked(extractStructured)
const mockedGenerateText = vi.mocked(generateText)
const mockedCreateResearchTools = vi.mocked(createResearchTools)
void createModel // referenced only via the mock above

const fakeProvider: ProviderConfig = { id: 'p1', name: 'Test', baseURL: 'https://x.test', apiKey: '', models: ['m'] }

/** Script extractStructured's response by WHICH prompt it was called with (Plan /
 *  Reflect / Verify's audit+refute all share this one function in research.ts).
 *  Any un-scripted call throws loudly rather than silently returning undefined,
 *  so a test that forgets a branch fails fast with a clear message. */
function scriptExtract(handlers: {
  plan?: (p: string) => unknown
  reflect?: (p: string) => unknown
  audit?: (p: string) => unknown
  refute?: (p: string) => unknown
}) {
  mockedExtractStructured.mockImplementation(async (_model: unknown, prompt: unknown) => {
    const p = String(prompt)
    if (p.includes('Break this research question into a concrete plan')) {
      if (!handlers.plan) throw new Error('unscripted plan() call')
      return handlers.plan(p)
    }
    if (p.includes('Assess coverage of these sub-questions')) {
      if (!handlers.reflect) throw new Error('unscripted reflect() call')
      return handlers.reflect(p)
    }
    if (p.includes('Audit this research report')) {
      return handlers.audit ? handlers.audit(p) : { issues: [], loadBearing: [] }
    }
    if (p.includes('Try hard to REFUTE this claim')) {
      if (!handlers.refute) throw new Error('unscripted refute() call')
      return handlers.refute(p)
    }
    throw new Error(`unscripted extractStructured prompt: ${p.slice(0, 100)}`)
  })
}

const EMPTY_TURN = { parts: [] as UIPart[], responseMessages: [], stop: { reason: 'completed' as const, stepsUsed: 1 } }

beforeEach(() => {
  vi.clearAllMocks()
  mockedCreateResearchTools.mockReturnValue({})
  mockedGenerateText.mockResolvedValue({ text: '# Report\n\nSome synthesized content.', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as any)
})

describe('reflect() resilience (F1 — CRITICAL)', () => {
  it('retries a transient extractStructured failure via resilient() instead of fabricating supported:true', async () => {
    vi.useFakeTimers()
    try {
      const plan = { subQuestions: ['q1', 'q2', 'q3'], outline: ['a'] }
      let reflectCalls = 0
      scriptExtract({
        plan: () => plan,
        reflect: () => {
          reflectCalls++
          if (reflectCalls === 1) throw { statusCode: 429, message: 'rate limited' }
          return {
            assessments: plan.subQuestions.map((q) => ({ subQuestion: q, supported: true })),
            done: true,
          }
        },
      })
      mockedRunAgentTurn.mockResolvedValue(EMPTY_TURN)

      const onPause = vi.fn()
      const runPromise = runResearch({
        taskId: 't1',
        question: 'What is X?',
        provider: fakeProvider,
        modelId: 'm',
        onUpdate: vi.fn(),
        signal: new AbortController().signal,
        onPause,
      })
      // Let the transient failure's backoff timer elapse (max possible ~5000ms).
      await vi.advanceTimersByTimeAsync(6_000)
      const result = await runPromise

      // The failure must have reached resilient()'s retry/pause machinery...
      expect(onPause).toHaveBeenCalledTimes(1)
      // ...and reflect() must have been called AGAIN (the retry), not swallowed once.
      expect(reflectCalls).toBe(2)
      // Coverage reflects the REAL second assessment, not a fabricated blanket true
      // asserted the instant the first (transient) failure was caught.
      expect(result.notebook.coverage['q1']?.supported).toBe(true)
      expect(result.notebook.coverage['q2']?.supported).toBe(true)
      expect(result.notebook.coverage['q3']?.supported).toBe(true)
      expect(result.partial).toBeFalsy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('on a genuinely non-retryable (permanent) failure, leaves coverage untouched rather than asserting supported:true', async () => {
    const plan = { subQuestions: ['q1'], outline: [] }
    scriptExtract({
      plan: () => plan,
      // Every reflect() call fails the same permanent way — never retried, never
      // fabricated. The loop must still terminate (via MAX_GATHER_ROUNDS) and
      // produce a report rather than hang or crash.
      reflect: () => {
        throw { statusCode: 400, message: 'schema rejected' }
      },
    })
    mockedRunAgentTurn.mockResolvedValue(EMPTY_TURN)
    const onPause = vi.fn()

    const result = await runResearch({
      taskId: 't1',
      question: 'What is X?',
      provider: fakeProvider,
      modelId: 'm',
      onUpdate: vi.fn(),
      signal: new AbortController().signal,
      onPause,
    })

    // A permanent failure must not retry/pause — it can never succeed.
    expect(onPause).not.toHaveBeenCalled()
    // At minimum: never fabricate supported:true for a sub-question that was
    // never actually assessed. Coverage stays untouched (still open).
    expect(result.notebook.coverage['q1']).toBeUndefined()
    // The run still completes (report gets written from whatever the notebook has).
    expect(result.report.length).toBeGreaterThan(0)
  })
})

describe('planResearch() resilience (F2 — HIGH)', () => {
  it('retries a transient extractStructured failure instead of silently degrading to a one-question plan', async () => {
    vi.useFakeTimers()
    try {
      const realPlan = { subQuestions: ['q1', 'q2', 'q3'], outline: ['sec1', 'sec2'] }
      let planCalls = 0
      scriptExtract({
        plan: () => {
          planCalls++
          if (planCalls === 1) throw { statusCode: 503, message: 'provider down' }
          return realPlan
        },
        reflect: () => ({
          assessments: realPlan.subQuestions.map((q) => ({ subQuestion: q, supported: true })),
          done: true,
        }),
      })
      mockedRunAgentTurn.mockResolvedValue(EMPTY_TURN)
      const onPause = vi.fn()

      const runPromise = runResearch({
        taskId: 't1',
        question: 'What is X?',
        provider: fakeProvider,
        modelId: 'm',
        onUpdate: vi.fn(),
        signal: new AbortController().signal,
        onPause,
      })
      await vi.advanceTimersByTimeAsync(6_000)
      const result = await runPromise

      expect(onPause).toHaveBeenCalledTimes(1)
      expect(planCalls).toBe(2)
      // The REAL multi-question plan survived, not the degraded 1-question fallback.
      expect(result.notebook.plan.subQuestions).toEqual(['q1', 'q2', 'q3'])
      expect(result.notebook.plan.outline).toEqual(['sec1', 'sec2'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the live step log stays bounded (F5 — MEDIUM)', () => {
  it('caps the payload handed to onUpdate even when a single round produces far more than the storage cap worth of steps', async () => {
    scriptExtract({
      plan: () => ({ subQuestions: ['q1'], outline: [] }),
      reflect: () => ({ assessments: [{ subQuestion: 'q1', supported: true }], done: true }),
    })
    const manyParts: UIPart[] = Array.from({ length: 250 }, (_, i) => ({
      type: 'tool',
      toolCallId: `c${i}`,
      toolName: 'WebSearch',
      input: { query: `q${i}` },
      output: { results: [] },
      state: 'done',
    }))
    mockedRunAgentTurn.mockResolvedValue({ parts: manyParts, responseMessages: [], stop: { reason: 'completed', stepsUsed: 1 } })

    const onUpdate = vi.fn()
    await runResearch({
      taskId: 't1',
      question: 'Q',
      provider: fakeProvider,
      modelId: 'm',
      onUpdate,
      signal: new AbortController().signal,
    })

    expect(onUpdate).toHaveBeenCalled()
    for (const call of onUpdate.mock.calls) {
      const steps = call[0] as unknown[]
      // MAX_STEPS (200, researchTasks.ts's own private constant) + 1 marker row —
      // mirrored here since it isn't exported; capSteps()'s own tests pin the
      // exact trim/marker behavior.
      expect(steps.length).toBeLessThanOrEqual(201)
    }
    // Sanity: the round genuinely produced more than the cap, so the assertion
    // above isn't vacuously true because nothing ever grew large.
    const maxSeen = Math.max(...onUpdate.mock.calls.map((c) => (c[0] as unknown[]).length))
    expect(maxSeen).toBeGreaterThan(50)
  })
})

describe('synthesize() empty-completion fallback (F6 — MEDIUM)', () => {
  it('falls back to the notebook-derived report when synthesize resolves with an empty string (not a throw)', async () => {
    scriptExtract({
      plan: () => ({ subQuestions: ['q1'], outline: [] }),
      reflect: () => ({ assessments: [{ subQuestion: 'q1', supported: true }], done: true }),
    })
    mockedRunAgentTurn.mockResolvedValue(EMPTY_TURN)
    // A legitimately empty completion — not a rejection — from the synthesis call.
    mockedGenerateText.mockResolvedValue({ text: '', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } } as any)

    const result = await runResearch({
      taskId: 't1',
      question: 'What is the capital of Freedonia?',
      provider: fakeProvider,
      modelId: 'm',
      onUpdate: vi.fn(),
      signal: new AbortController().signal,
    })

    expect(result.report).not.toBe('')
    expect(result.report).toContain('What is the capital of Freedonia?')
  })
})

describe('phase-order / deadline / abort behavior (general coverage)', () => {
  it('finalizes immediately with a partial fallback report when the deadline has already passed, without attempting any phase', async () => {
    const result = await runResearch({
      taskId: 't1',
      question: 'Q',
      provider: fakeProvider,
      modelId: 'm',
      onUpdate: vi.fn(),
      signal: new AbortController().signal,
      deadlineAt: Date.now() - 1_000, // already past
    })

    expect(result.partial).toBe(true)
    expect(result.report).toContain('Q')
    expect(mockedExtractStructured).not.toHaveBeenCalled()
    expect(mockedRunAgentTurn).not.toHaveBeenCalled()
  })

  it('propagates an abort instead of resolving with a fabricated report when the task is stopped mid-gather', async () => {
    const ctrl = new AbortController()
    scriptExtract({ plan: () => ({ subQuestions: ['q1'], outline: [] }) })
    mockedRunAgentTurn.mockImplementation(async () => {
      ctrl.abort() // simulates a user Stop landing mid-round
      throw new DOMException('stopped', 'AbortError')
    })

    await expect(
      runResearch({
        taskId: 't1',
        question: 'Q',
        provider: fakeProvider,
        modelId: 'm',
        onUpdate: vi.fn(),
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mockedGenerateText).not.toHaveBeenCalled() // never reached Synthesize
  })
})
