import { describe, it, expect, vi } from 'vitest'
import {
  ResearchDeadlineError,
  classifyError,
  describeError,
  isAbortError,
  backoffDelay,
  withResilience,
  type SleepOutcome,
} from './resilience'

describe('classifyError', () => {
  it('marks an AbortError as an abort (not transient)', () => {
    const err = new DOMException('stopped', 'AbortError')
    expect(isAbortError(err)).toBe(true)
    expect(classifyError(err).kind).toBe('abort')
  })

  it('treats a per-attempt TimeoutError as transient, not an abort', () => {
    // AbortSignal.timeout() fires a TimeoutError; a hung request must retry, not stop.
    const err = new DOMException('timed out', 'TimeoutError')
    expect(isAbortError(err)).toBe(false)
    expect(classifyError(err).kind).toBe('transient')
  })

  it('classifies rate limits, auth, and 5xx by status code — all transient', () => {
    expect(classifyError({ statusCode: 429 }).reason).toMatch(/rate limit/i)
    expect(classifyError({ status: 401 }).reason).toMatch(/api key|auth|rejected/i)
    expect(classifyError({ statusCode: 503 }).reason).toMatch(/unavailable|503/i)
    for (const s of [429, 401, 403, 500, 502, 503, 504]) {
      expect(classifyError({ statusCode: s }).kind).toBe('transient')
    }
  })

  it('classifies network failures from the message', () => {
    expect(classifyError(new TypeError('fetch failed')).reason).toMatch(/network|connection/i)
    expect(classifyError(new Error('ECONNREFUSED 127.0.0.1:11434')).reason).toMatch(/network|connection/i)
    expect(describeError(new Error('boom'))).toMatch(/retry/i)
  })
})

describe('backoffDelay', () => {
  it('is bounded to [half, full] of the exponential via equal jitter, never zero', () => {
    expect(backoffDelay(0, { rng: () => 0 })).toBe(2500) // base 5000 → half
    expect(backoffDelay(0, { rng: () => 1 })).toBe(5000) // base 5000 → full
    expect(backoffDelay(0, { rng: () => 0 })).toBeGreaterThan(0)
  })

  it('grows with the attempt number and caps out', () => {
    const d = (a: number) => backoffDelay(a, { rng: () => 1 })
    expect(d(0)).toBeLessThan(d(1))
    expect(d(1)).toBeLessThan(d(2))
    expect(d(100)).toBe(120_000) // capped
    expect(d(100)).toBeLessThanOrEqual(120_000)
  })
})

/** A fake clock + scripted sleep so the retry loop is deterministic and instant. */
function harness(opts: { deadlineAfter?: number; sleepOutcomes?: SleepOutcome[] } = {}) {
  let clock = 1_000
  const step = 1_000
  const sleepOutcomes = opts.sleepOutcomes ?? []
  let sleepIdx = 0
  const sleeps: number[] = []
  return {
    now: () => clock,
    advance: (ms: number) => (clock += ms),
    deadlineAt: 1_000 + (opts.deadlineAfter ?? 1_000_000),
    sleeps,
    sleep: vi.fn(async (ms: number): Promise<SleepOutcome> => {
      sleeps.push(ms)
      clock += ms || step // time passes while we sleep
      return sleepOutcomes[sleepIdx++] ?? 'elapsed'
    }),
  }
}

describe('withResilience', () => {
  it('returns the value on first success without pausing', async () => {
    const h = harness()
    const onPause = vi.fn()
    const fn = vi.fn(async () => 'ok')
    const out = await withResilience(fn, {
      signal: new AbortController().signal,
      deadlineAt: h.deadlineAt,
      now: h.now,
      sleep: h.sleep,
      onPause,
    })
    expect(out).toBe('ok')
    expect(onPause).not.toHaveBeenCalled()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('pauses on a transient error, then retries to success (and fires onResume)', async () => {
    const h = harness()
    const onPause = vi.fn()
    const onResume = vi.fn()
    let calls = 0
    const fn = vi.fn(async () => {
      if (++calls < 3) throw new TypeError('fetch failed')
      return 'recovered'
    })
    const out = await withResilience(fn, {
      signal: new AbortController().signal,
      deadlineAt: h.deadlineAt,
      now: h.now,
      sleep: h.sleep,
      rng: () => 1,
      onPause,
      onResume,
    })
    expect(out).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(onPause).toHaveBeenCalledTimes(2)
    expect(onResume).toHaveBeenCalledTimes(1)
    // Backoff grew between the two waits.
    expect(h.sleeps[1]).toBeGreaterThan(h.sleeps[0])
  })

  it('resets backoff after the connection returns (online outcome)', async () => {
    const h = harness({ sleepOutcomes: ['elapsed', 'online', 'elapsed'] })
    let calls = 0
    const fn = vi.fn(async () => {
      if (++calls < 4) throw new TypeError('fetch failed')
      return 'ok'
    })
    await withResilience(fn, {
      signal: new AbortController().signal,
      deadlineAt: h.deadlineAt,
      now: h.now,
      sleep: h.sleep,
      rng: () => 1,
    })
    // sleeps: attempt0=5000, attempt1=10000, then 'online' reset → attempt0 again=5000
    expect(h.sleeps[2]).toBe(5000)
    expect(h.sleeps[2]).toBeLessThan(h.sleeps[1])
  })

  it('propagates immediately when the task signal is aborted (manual Stop wins)', async () => {
    const ctrl = new AbortController()
    const h = harness()
    const fn = vi.fn(async () => {
      ctrl.abort()
      throw new Error('provider 500')
    })
    await expect(
      withResilience(fn, { signal: ctrl.signal, deadlineAt: h.deadlineAt, now: h.now, sleep: h.sleep }),
    ).rejects.toBeTruthy()
    expect(fn).toHaveBeenCalledTimes(1) // no retry after abort
  })

  it('throws ResearchDeadlineError once the deadline passes instead of retrying forever', async () => {
    // Deadline 3s out; each failed attempt sleeps ~ and advances the clock past it.
    const h = harness({ deadlineAfter: 3_000 })
    const fn = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(
      withResilience(fn, { signal: new AbortController().signal, deadlineAt: h.deadlineAt, now: h.now, sleep: h.sleep, rng: () => 1 }),
    ).rejects.toBeInstanceOf(ResearchDeadlineError)
  })

  it('throws ResearchDeadlineError at entry when already past the deadline', async () => {
    const h = harness({ deadlineAfter: -1 }) // deadline already behind now
    const fn = vi.fn(async () => 'never')
    await expect(
      withResilience(fn, { signal: new AbortController().signal, deadlineAt: h.deadlineAt, now: h.now, sleep: h.sleep }),
    ).rejects.toBeInstanceOf(ResearchDeadlineError)
    expect(fn).not.toHaveBeenCalled()
  })
})
