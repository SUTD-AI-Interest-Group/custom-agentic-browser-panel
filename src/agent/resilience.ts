/**
 * Deadline-aware, connectivity-resilient retry for the background research phases.
 *
 * The research host must survive a network drop, a provider outage, or a hung
 * socket without losing the task — and, by product decision, without ever giving
 * up before the 24h wall-clock cap or a manual Stop. This module is the in-run
 * half of that (Layer 1): wrap a phase call in `withResilience` and any failure
 * becomes a *pause* (surfaced to the user with a reason) followed by a backoff
 * retry, until the phase succeeds, the deadline passes, or the task is aborted.
 *
 * Kept PURE and Chrome-free (like browsePolicy / toolDiscovery) so the decision
 * logic is unit-tested directly; the one impure default (`sleep`, which listens
 * for the `online` event and a timer) is injectable, and the wrapper's loop is
 * driven entirely through injected `now`/`sleep`/`rng` in tests.
 */

/** Thrown by `withResilience` when the 24h deadline passes mid-retry. The research
 *  loop catches this specifically to finalize a partial report instead of erroring. */
export class ResearchDeadlineError extends Error {
  constructor(message = 'The research deadline was reached.') {
    super(message)
    this.name = 'ResearchDeadlineError'
  }
}

/** Backoff schedule (equal jitter). */
export const DEFAULT_BACKOFF = { base: 5_000, factor: 2, cap: 120_000 } as const

/**
 * Per-attempt timeout. A hung TCP socket that never rejects would otherwise defeat
 * the whole retry mechanism, so each attempt runs under this ceiling and a timeout
 * is treated as a (transient) retry. Generous so a slow local model doing a large
 * synthesis is never cut off mid-generation.
 */
export const PER_ATTEMPT_TIMEOUT_MS = 300_000

export interface ErrorInfo {
  /** 'abort' = a real Stop (do not retry); 'transient' = pause + retry. */
  kind: 'abort' | 'transient'
  /** Human-readable reason shown on the paused card. */
  reason: string
}

/** True only for a genuine AbortError — a per-attempt TimeoutError is transient. */
export function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError'
}

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const e = err as Record<string, any>
    const s = e.statusCode ?? e.status ?? e.response?.status ?? e.cause?.statusCode
    if (typeof s === 'number') return s
  }
  return undefined
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  return ''
}

function truncate(s: string, max = 140): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * Classify a failure into a Stop vs a retryable pause, plus a human reason. By
 * design EVERYTHING except a real abort is transient (we retry until the deadline);
 * the status/message inspection only picks a friendlier reason for the paused card.
 */
export function classifyError(err: unknown): ErrorInfo {
  if (isAbortError(err)) return { kind: 'abort', reason: 'Cancelled' }
  const status = statusOf(err)
  const msg = messageOf(err)
  if (status === 429) return { kind: 'transient', reason: 'Rate limited by the provider — will retry' }
  if (status === 401 || status === 403) {
    return { kind: 'transient', reason: 'Provider rejected the request (check the API key) — will retry' }
  }
  if (status && [408, 425, 500, 502, 503, 504].includes(status)) {
    return { kind: 'transient', reason: `Provider is unavailable (HTTP ${status}) — will retry` }
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(msg)) return { kind: 'transient', reason: 'The request timed out — will retry' }
  if (/fetch failed|network|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|Failed to fetch|Load failed|offline/i.test(msg)) {
    return { kind: 'transient', reason: 'Network unavailable — will resume when the connection returns' }
  }
  if (status && status >= 400) return { kind: 'transient', reason: `Provider error (HTTP ${status}) — will retry` }
  return { kind: 'transient', reason: msg ? `${truncate(msg)} — will retry` : 'Temporary error — will retry' }
}

/** Convenience: the paused-card reason for an error. */
export function describeError(err: unknown): string {
  return classifyError(err).reason
}

export interface BackoffOptions {
  base?: number
  factor?: number
  cap?: number
  rng?: () => number
}

/**
 * Equal-jitter exponential backoff: `half + rand(0, half)` where `half` is half of
 * the (capped) exponential term. Grows with `attempt`, caps at `cap`, and is never
 * zero — so a paused task neither hammers the provider nor busy-loops.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const { base = DEFAULT_BACKOFF.base, factor = DEFAULT_BACKOFF.factor, cap = DEFAULT_BACKOFF.cap, rng = Math.random } = opts
  const exp = Math.min(cap, base * Math.pow(factor, Math.max(0, attempt)))
  const half = exp / 2
  return Math.round(half + rng() * half)
}

export type SleepOutcome = 'elapsed' | 'aborted' | 'online'

/**
 * Sleep that resolves early when the connection returns (`online` event) or the
 * task is aborted. Impure (timer + global event listener); injected in tests. Uses
 * `globalThis` so it works in the offscreen document without assuming `window`.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<SleepOutcome> {
  return new Promise<SleepOutcome>((resolve) => {
    if (signal.aborted) return resolve('aborted')
    let settled = false
    const g = globalThis as { addEventListener?: (t: string, cb: () => void) => void; removeEventListener?: (t: string, cb: () => void) => void }
    const onOnline = () => finish('online')
    const onAbort = () => finish('aborted')
    const finish = (v: SleepOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      try {
        g.removeEventListener?.('online', onOnline)
      } catch {
        /* no online events here */
      }
      resolve(v)
    }
    const timer = setTimeout(() => finish('elapsed'), ms)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      g.addEventListener?.('online', onOnline)
    } catch {
      /* no online events here */
    }
  })
}

/** Merge the task signal with a fresh per-attempt timeout, degrading gracefully. */
function defaultAttemptSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  try {
    if (typeof AbortSignal !== 'undefined' && 'any' in AbortSignal && 'timeout' in AbortSignal) {
      return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    }
  } catch {
    /* fall through */
  }
  return signal
}

export interface ResilienceOptions {
  /** The task's abort signal — a real abort (Stop / deadline finalize) propagates. */
  signal: AbortSignal
  /** Absolute epoch-ms after which we stop retrying and finalize (24h cap). */
  deadlineAt: number
  /** Called each time the phase enters a paused/waiting state. */
  onPause?: (info: { reason: string; attempt: number; nextRetryAt: number }) => void
  /** Called once when a previously-paused phase makes progress again. */
  onResume?: () => void
  // --- injectable for tests / non-DOM contexts ---
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<SleepOutcome>
  rng?: () => number
  perAttemptTimeoutMs?: number
  makeAttemptSignal?: (signal: AbortSignal, timeoutMs: number) => AbortSignal
}

function abortError(): Error {
  try {
    return new DOMException('The research task was cancelled.', 'AbortError')
  } catch {
    const e = new Error('The research task was cancelled.')
    e.name = 'AbortError'
    return e
  }
}

/**
 * Run `fn`, retrying transient failures with backoff until it succeeds, the task is
 * aborted, or the deadline passes (→ `ResearchDeadlineError`). `fn` receives a
 * per-attempt signal (task signal + timeout) so a hung request becomes a retry.
 */
export async function withResilience<T>(fn: (signal: AbortSignal) => Promise<T>, opts: ResilienceOptions): Promise<T> {
  const {
    signal,
    deadlineAt,
    onPause,
    onResume,
    now = Date.now,
    sleep: sleepFn = sleep,
    rng = Math.random,
    perAttemptTimeoutMs = PER_ATTEMPT_TIMEOUT_MS,
    makeAttemptSignal = defaultAttemptSignal,
  } = opts

  let attempt = 0
  let paused = false
  for (;;) {
    if (signal.aborted) throw abortError()
    if (now() >= deadlineAt) throw new ResearchDeadlineError()
    try {
      const result = await fn(makeAttemptSignal(signal, perAttemptTimeoutMs))
      if (paused) {
        paused = false
        onResume?.()
      }
      return result
    } catch (err) {
      // A real Stop (or deadline-driven finalize) always wins over a retry.
      if (signal.aborted) throw err
      if (now() >= deadlineAt) throw new ResearchDeadlineError()
      // Everything else — network drop, provider 5xx/429/auth, per-attempt timeout —
      // is a transient pause: surface a reason, wait, retry.
      const reason = describeError(err)
      const raw = backoffDelay(attempt, { rng })
      const delay = Math.max(0, Math.min(raw, deadlineAt - now()))
      const nextRetryAt = now() + delay
      paused = true
      onPause?.({ reason, attempt: attempt + 1, nextRetryAt })
      const outcome = await sleepFn(delay, signal)
      if (outcome === 'aborted' || signal.aborted) throw abortError()
      // Connectivity returned → retry promptly with a fresh (short) backoff.
      attempt = outcome === 'online' ? 0 : attempt + 1
    }
  }
}
