// Public shapes for the observability façade. These are transport-agnostic on
// purpose: call sites depend only on `Observer`/`Trace`/`Generation`/`Span`, so
// the Langfuse ingestion transport in `langfuseClient.ts` can be swapped (e.g.
// for OTLP-over-fetch) without touching a single instrumentation site.

/** Token usage as the Vercel AI SDK v7 reports it (the subset we read). */
export interface ModelUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
}

/** Langfuse observation level; ERROR flags a failed step/tool. */
export type ObservationLevel = 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR'

export interface TraceOptions {
  /** Human-readable trace name, e.g. the first line of the user message. */
  name: string
  /** Groups a chat's turns in Langfuse's Sessions view (the conversation id). */
  sessionId?: string
  userId?: string
  input?: unknown
  metadata?: Record<string, unknown>
  tags?: string[]
}

export interface GenerationOptions {
  name: string
  /** Model id — Langfuse matches it to its price table to compute cost. */
  model?: string
  input?: unknown
  metadata?: Record<string, unknown>
  parentObservationId?: string
  /** ISO start time; defaults to now. Set explicitly to record real latency. */
  startTime?: string
}

export interface GenerationEnd {
  output?: unknown
  /** Raw AI SDK usage; mapped to Langfuse `usageDetails` unless one is given. */
  usage?: ModelUsage
  usageDetails?: Record<string, number>
  model?: string
  finishReason?: string
  level?: ObservationLevel
  statusMessage?: string
  metadata?: Record<string, unknown>
}

export interface SpanOptions {
  name: string
  input?: unknown
  metadata?: Record<string, unknown>
  parentObservationId?: string
}

export interface SpanEnd {
  output?: unknown
  level?: ObservationLevel
  statusMessage?: string
  metadata?: Record<string, unknown>
}

export interface EventOptions {
  name: string
  input?: unknown
  output?: unknown
  level?: ObservationLevel
  metadata?: Record<string, unknown>
  parentObservationId?: string
}

export interface TraceEnd {
  output?: unknown
  metadata?: Record<string, unknown>
}

/** A model call within a trace. `end()` records output, tokens, and status. */
export interface Generation {
  readonly id: string
  end(o?: GenerationEnd): void
}

/** A unit of work (typically a tool call) within a trace. */
export interface Span {
  readonly id: string
  end(o?: SpanEnd): void
}

/** One top-level operation (a chat turn, a research task, a dream, …). */
export interface Trace {
  readonly id: string
  generation(o: GenerationOptions): Generation
  span(o: SpanOptions): Span
  event(o: EventOptions): void
  update(o: TraceEnd): void
  end(o?: TraceEnd): void
}

/**
 * The façade every instrumentation site talks to. When observability is off,
 * `getObserver()` returns a no-op whose handles do nothing — so instrumentation
 * lines can live permanently at call sites with no `if (enabled)` guards and no
 * runtime cost. Every method is exception-safe: a Langfuse failure never
 * surfaces to the user or breaks a turn.
 */
export interface Observer {
  readonly enabled: boolean
  startTrace(o: TraceOptions): Trace
  /** Send any buffered events now. Awaited at the end of each operation. */
  flush(): Promise<void>
}
