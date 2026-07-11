// The observability façade. `getObserver()` returns a live Langfuse-backed
// Observer when the beta toggle is on and keys are set, otherwise a shared
// no-op. Content redaction (captureContent / captureScreenshots) is enforced
// here, before anything enters the ingestion buffer, so call sites never worry
// about it. Every method is exception-safe.

import {
  DEFAULT_OBSERVABILITY,
  loadSettings,
  observabilityConfig,
  type ObservabilityConfig,
} from '../../data/settings'
import { LangfuseIngestionClient } from './langfuseClient'
import type {
  EventOptions,
  Generation,
  GenerationEnd,
  GenerationOptions,
  ModelUsage,
  Observer,
  Span,
  SpanEnd,
  SpanOptions,
  Trace,
  TraceEnd,
  TraceOptions,
} from './types'

export type { Observer, Trace, Generation, Span } from './types'

// ---------------------------------------------------------------------------
// Mapping & redaction helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Map AI SDK v7 usage to Langfuse `usageDetails` (input/output/total drive cost). */
export function mapUsage(u?: ModelUsage): Record<string, number> | undefined {
  if (!u) return undefined
  const d: Record<string, number> = {}
  if (typeof u.inputTokens === 'number') d.input = u.inputTokens
  if (typeof u.outputTokens === 'number') d.output = u.outputTokens
  if (typeof u.totalTokens === 'number') d.total = u.totalTokens
  if (typeof u.reasoningTokens === 'number') d.reasoning = u.reasoningTokens
  if (typeof u.cachedInputTokens === 'number') d.cache_read = u.cachedInputTokens
  return Object.keys(d).length ? d : undefined
}

const MAX_STRING = 200_000

/**
 * Deep-copy a value for ingestion, stripping data:image payloads unless
 * screenshots are enabled and capping pathologically long strings (a 40k-char
 * DOM dump is fine; a base64 image is not). Never throws.
 */
export function sanitize(value: unknown, keepImages: boolean): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (!keepImages && v.startsWith('data:image/')) return '[image omitted]'
      return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…[truncated]` : v
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val)
      return out
    }
    return v
  }
  try {
    return walk(value)
  } catch {
    return undefined
  }
}

/** Drop undefined-valued keys so the ingestion body stays compact. */
function clean(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) if (v !== undefined) out[k] = v
  return out
}

function mergeMeta(
  a?: Record<string, unknown>,
  b?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!a && !b) return undefined
  return { ...a, ...b }
}

const now = () => new Date().toISOString()

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

class LiveObserver implements Observer {
  readonly enabled = true
  private readonly client: LangfuseIngestionClient
  private readonly keepImages: boolean
  private readonly captureContent: boolean

  constructor(cfg: ObservabilityConfig) {
    this.client = new LangfuseIngestionClient(cfg.host, cfg.publicKey, cfg.secretKey)
    this.captureContent = cfg.captureContent
    this.keepImages = cfg.captureContent && cfg.captureScreenshots
    console.info('[langfuse] observability ENABLED →', cfg.host, {
      captureContent: cfg.captureContent,
      captureScreenshots: cfg.captureScreenshots,
    })
  }

  /** Apply the content-capture policy to any input/output value. */
  content(v: unknown): unknown {
    if (v === undefined || !this.captureContent) return undefined
    return sanitize(v, this.keepImages)
  }

  emit(type: string, body: Record<string, unknown>): void {
    this.client.enqueue(type, clean(body))
  }

  startTrace(o: TraceOptions): Trace {
    const id = uuid()
    try {
      this.emit('trace-create', {
        id,
        timestamp: now(),
        name: o.name,
        sessionId: o.sessionId,
        userId: o.userId,
        input: this.content(o.input),
        metadata: o.metadata,
        tags: o.tags,
      })
    } catch {
      /* best-effort */
    }
    return new LiveTrace(this, id)
  }

  flush(): Promise<void> {
    return this.client.flush()
  }
}

class LiveTrace implements Trace {
  constructor(
    private readonly obs: LiveObserver,
    readonly id: string,
  ) {}

  generation(o: GenerationOptions): Generation {
    const id = uuid()
    try {
      this.obs.emit('generation-create', {
        id,
        traceId: this.id,
        name: o.name,
        startTime: o.startTime ?? now(),
        model: o.model,
        input: this.obs.content(o.input),
        metadata: o.metadata,
        parentObservationId: o.parentObservationId,
      })
    } catch {
      /* best-effort */
    }
    return new LiveGeneration(this.obs, this.id, id)
  }

  span(o: SpanOptions): Span {
    const id = uuid()
    try {
      this.obs.emit('span-create', {
        id,
        traceId: this.id,
        name: o.name,
        startTime: now(),
        input: this.obs.content(o.input),
        metadata: o.metadata,
        parentObservationId: o.parentObservationId,
      })
    } catch {
      /* best-effort */
    }
    return new LiveSpan(this.obs, this.id, id)
  }

  event(o: EventOptions): void {
    try {
      this.obs.emit('event-create', {
        id: uuid(),
        traceId: this.id,
        name: o.name,
        startTime: now(),
        input: this.obs.content(o.input),
        output: this.obs.content(o.output),
        level: o.level,
        metadata: o.metadata,
        parentObservationId: o.parentObservationId,
      })
    } catch {
      /* best-effort */
    }
  }

  update(o: TraceEnd): void {
    try {
      this.obs.emit('trace-create', {
        id: this.id,
        output: this.obs.content(o.output),
        metadata: o.metadata,
      })
    } catch {
      /* best-effort */
    }
  }

  end(o: TraceEnd = {}): void {
    this.update(o)
  }
}

class LiveGeneration implements Generation {
  constructor(
    private readonly obs: LiveObserver,
    private readonly traceId: string,
    readonly id: string,
  ) {}

  end(o: GenerationEnd = {}): void {
    try {
      this.obs.emit('generation-update', {
        id: this.id,
        traceId: this.traceId,
        endTime: now(),
        output: this.obs.content(o.output),
        model: o.model,
        usageDetails: o.usageDetails ?? mapUsage(o.usage),
        costDetails: o.costDetails,
        level: o.level,
        statusMessage: o.statusMessage,
        metadata: mergeMeta(o.metadata, o.finishReason ? { finishReason: o.finishReason } : undefined),
      })
    } catch {
      /* best-effort */
    }
  }
}

class LiveSpan implements Span {
  constructor(
    private readonly obs: LiveObserver,
    private readonly traceId: string,
    readonly id: string,
  ) {}

  end(o: SpanEnd = {}): void {
    try {
      this.obs.emit('span-update', {
        id: this.id,
        traceId: this.traceId,
        endTime: now(),
        output: this.obs.content(o.output),
        level: o.level,
        statusMessage: o.statusMessage,
        metadata: o.metadata,
      })
    } catch {
      /* best-effort */
    }
  }
}

function uuid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `lf-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  }
}

// ---------------------------------------------------------------------------
// No-op implementation (disabled path — zero cost, never throws)
// ---------------------------------------------------------------------------

const NOOP_GENERATION: Generation = { id: '', end() {} }
const NOOP_SPAN: Span = { id: '', end() {} }
const NOOP_TRACE: Trace = {
  id: '',
  generation: () => NOOP_GENERATION,
  span: () => NOOP_SPAN,
  event() {},
  update() {},
  end() {},
}
export const NOOP_OBSERVER: Observer = {
  enabled: false,
  startTrace: () => NOOP_TRACE,
  flush: async () => {},
}

// ---------------------------------------------------------------------------
// Config cache + factory
// ---------------------------------------------------------------------------

let cachedConfig: ObservabilityConfig = DEFAULT_OBSERVABILITY
let live: { sig: string; observer: LiveObserver } | null = null
/** Warn once, not on every turn, when the toggle is on but keys are missing. */
let warnedIncomplete = false

async function refresh(): Promise<void> {
  try {
    cachedConfig = observabilityConfig(await loadSettings())
  } catch {
    /* keep last-known config */
  }
}

// Eagerly load config and track changes so toggling the beta switch takes effect
// without a reload — works in both the side panel and the service worker.
void refresh()
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) void refresh()
  })
} catch {
  /* chrome.storage unavailable (e.g. tests) */
}

function signature(c: ObservabilityConfig): string {
  return `${c.host}|${c.publicKey}|${c.secretKey}|${c.captureContent}|${c.captureScreenshots}`
}

/**
 * Get the current observer. Pass an explicit config when the caller already has
 * settings loaded (avoids the async cache race); otherwise the module-cached
 * config is used. Returns a no-op when observability is disabled or unconfigured.
 * The live observer (and its ingestion buffer) is reused across calls with the
 * same config so events batch together.
 */
export function getObserver(config?: ObservabilityConfig): Observer {
  const cfg = config ?? cachedConfig
  if (!cfg.enabled) return NOOP_OBSERVER
  // Enabled but unusable: warn rather than silently no-op — an empty key here is
  // otherwise indistinguishable from "observability is off" and produces no traces.
  if (!cfg.publicKey || !cfg.secretKey || !cfg.host) {
    if (!warnedIncomplete) {
      warnedIncomplete = true
      console.warn('[langfuse] observability is ON but not configured — missing', {
        publicKey: !cfg.publicKey,
        secretKey: !cfg.secretKey,
        host: !cfg.host,
      })
    }
    return NOOP_OBSERVER
  }
  const sig = signature(cfg)
  if (live && live.sig === sig) return live.observer
  live = { sig, observer: new LiveObserver(cfg) }
  return live.observer
}
