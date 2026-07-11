// Opt-in Langfuse observability. See `docs/superpowers/specs/` for the design.
export { getObserver, NOOP_OBSERVER, mapUsage, sanitize } from './observer'
export { instrumentToolset } from './instrumentTools'
export { testLangfuseConnection } from './langfuseClient'
export type {
  Observer,
  Trace,
  Generation,
  Span,
  ModelUsage,
  ObservationLevel,
  TraceOptions,
  GenerationOptions,
  GenerationEnd,
  SpanOptions,
  SpanEnd,
  EventOptions,
  TraceEnd,
} from './types'
