// Browser-safe Langfuse ingestion transport.
//
// Posts batches of events to Langfuse's `/api/public/ingestion` endpoint with
// HTTP Basic auth (base64 of publicKey:secretKey). Pure `fetch` — no Node
// dependencies — so it runs identically in the side panel and the MV3 service
// worker (memory dreaming). Every network call is best-effort: a broken key,
// bad host, or offline state is swallowed and never breaks a turn.
//
// Why the ingestion API (not OTLP): the official AI-SDK↔Langfuse OTLP path uses
// `@langfuse/otel`'s LangfuseSpanProcessor, which requires the Node OpenTelemetry
// SDK and cannot run in a browser/service-worker. The ingestion endpoint is the
// only clean browser-safe JSON transport; the `Observer` façade isolates it.

/** One event in an ingestion batch. `id` dedupes; `body.id` is the trace/observation id. */
interface QueuedEvent {
  id: string
  type: string
  timestamp: string
  body: Record<string, unknown>
}

/** Langfuse caps a batch at ~3.5 MB; flush well before that. */
const MAX_BATCH_BYTES = 3_000_000
const MAX_BATCH_EVENTS = 100
const FLUSH_DEBOUNCE_MS = 2_000

function uuid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `lf-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
  }
}

export class LangfuseIngestionClient {
  private queue: QueuedEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private approxBytes = 0
  private readonly url: string
  private readonly auth: string

  constructor(host: string, publicKey: string, secretKey: string) {
    this.url = `${host.replace(/\/+$/, '')}/api/public/ingestion`
    this.auth = `Basic ${btoa(`${publicKey}:${secretKey}`)}`
  }

  /** Buffer one event; flush eagerly if the batch is getting large. */
  enqueue(type: string, body: Record<string, unknown>): void {
    try {
      const event: QueuedEvent = { id: uuid(), type, timestamp: new Date().toISOString(), body }
      this.queue.push(event)
      this.approxBytes += approxSize(event)
      if (this.queue.length >= MAX_BATCH_EVENTS || this.approxBytes >= MAX_BATCH_BYTES) {
        void this.flush()
      } else {
        this.schedule()
      }
    } catch {
      // Never let instrumentation throw into the caller.
    }
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, FLUSH_DEBOUNCE_MS)
  }

  /** POST whatever is buffered. Awaited at the end of an operation to guarantee delivery. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0, this.queue.length)
    this.approxBytes = 0
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.auth },
        body: JSON.stringify({ batch }),
      })
      const payload = await readJson(res)
      // CRITICAL: Langfuse answers *input* errors with 207 + a per-event `errors`
      // list, NOT a 4xx — so `res.ok` alone proves nothing: a batch in which every
      // event was rejected also comes back 207/ok. Always inspect `errors`, or a
      // schema problem silently looks like success and no trace ever appears.
      if (!res.ok) {
        console.warn('[langfuse] ingestion failed — HTTP', res.status, payload ?? '(no body)')
        return
      }
      const errors = Array.isArray(payload?.errors) ? payload.errors : []
      if (errors.length > 0) {
        console.warn(`[langfuse] ${errors.length}/${batch.length} events REJECTED:`, errors)
      } else {
        const n = Array.isArray(payload?.successes) ? payload.successes.length : batch.length
        console.info(`[langfuse] ingested ${n} event(s)`)
      }
    } catch (err) {
      // Network / CORS / bad host. Still non-fatal for the turn, but never silent:
      // a swallowed error here is exactly why a missing trace is undiagnosable.
      console.warn('[langfuse] ingestion request failed (network/CORS/host):', err)
    }
  }
}

/** Cheap byte estimate for batch sizing (UTF-16 length is a fine upper-ish bound). */
function approxSize(event: QueuedEvent): number {
  try {
    return JSON.stringify(event).length
  } catch {
    return 1_000
  }
}

/** Ingestion response body, when it is JSON. Null on an empty/non-JSON body. */
interface IngestionResult {
  successes?: unknown[]
  errors?: unknown[]
}

async function readJson(res: Response): Promise<IngestionResult | null> {
  try {
    return (await res.json()) as IngestionResult
  } catch {
    return null
  }
}

/** Pull a human-readable reason out of one entry of the 207 `errors` array. */
function errorDetail(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; error?: unknown; status?: unknown }
    const msg = o.message ?? o.error
    if (msg) return `${o.status ? `[${String(o.status)}] ` : ''}${String(msg)}`
  }
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

/**
 * Send one throwaway trace to verify host + keys, for the settings "Test
 * connection" button. Returns a human-readable result; never throws.
 */
export async function testLangfuseConnection(
  host: string,
  publicKey: string,
  secretKey: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const url = `${host.replace(/\/+$/, '')}/api/public/ingestion`
    const ts = new Date().toISOString()
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${btoa(`${publicKey}:${secretKey}`)}` },
      body: JSON.stringify({
        batch: [
          { id: uuid(), type: 'trace-create', timestamp: ts, body: { id: uuid(), name: 'langfuse-connection-test', timestamp: ts } },
        ],
      }),
    })
    const payload = await readJson(res)
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: 'Auth failed — check the keys, and that the Host matches your project’s region (EU vs US).',
      }
    }
    if (!res.ok) return { ok: false, message: `Langfuse returned HTTP ${res.status}.` }
    // 207 is the success status, but a rejected event ALSO returns 207 — the real
    // verdict is the per-event `errors` list. Checking only res.ok gives a false ✓.
    const errors = Array.isArray(payload?.errors) ? payload.errors : []
    if (errors.length > 0) {
      return { ok: false, message: `Langfuse rejected the test event: ${errorDetail(errors[0]).slice(0, 180)}` }
    }
    return { ok: true, message: 'Connected — Langfuse accepted a test trace.' }
  } catch (err) {
    return {
      ok: false,
      message: `Network/CORS error — check the Host URL. ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
