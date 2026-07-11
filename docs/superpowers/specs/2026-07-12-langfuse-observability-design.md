# Langfuse Observability (Beta) — Design

Date: 2026-07-12
Branch: `observability-langfuse`

## Goal

Add opt-in, deep Langfuse observability for **every model-related action** in the
extension: chats, agent turns, per-step generations, tool calls, token counts,
cost, and background tasks (research, dreaming, vision, extraction, title
generation). Ships as a **beta toggle** in Settings → General. When the toggle
is off, **nothing** is tracked and there is zero network/overhead.

## Product decisions (locked)

- **Capture scope:** full **text** I/O by default (prompts, responses, tool
  inputs/outputs, page text, tokens, timings). Screenshots / set-of-marks images
  are attached only when a second **"Include screenshots"** sub-toggle is on
  (default **off** — heavy, can show sensitive pages).
- **Host:** default `https://cloud.langfuse.com`, but the Host field is editable
  so US (`us.cloud.langfuse.com`) and self-hosted URLs also work.
- **Placement:** an **"Observability (Beta)"** section inside the existing
  **General** settings tab, below Privacy.

## Why not the "official" integration

The blessed Langfuse ↔ AI SDK path (`@langfuse/otel` `LangfuseSpanProcessor` +
`@langfuse/vercel-ai-sdk` + `NodeSDK`) requires **Node.js ≥ 20/22** and cannot
run in an MV3 browser/service-worker context. Browser-viable routes are (A) web
OpenTelemetry → Langfuse OTLP endpoint, or (B) manual instrumentation shipped
through a browser-safe ingestion client driven by AI SDK v7 callbacks.

**Chosen: Approach B.** Rationale: tiny zero-dependency bundle; runs identically
in the side panel and the service worker (dreaming); full control over the exact
trace hierarchy; deterministic token/cost capture; graceful no-op when disabled.
We still leverage AI SDK v7's observability surface — its structured
`onStepFinish` / `onFinish` / `usage` / `providerMetadata` callbacks — we simply
map them to Langfuse ourselves rather than relying on OTel span emission (which
needs a Node collector we can't host in-browser).

Transport note: the client posts to `/api/public/ingestion` (Basic auth). This
endpoint is soft-deprecated in favor of OTLP but remains fully supported and is
the only clean browser-safe JSON transport. The Observer façade isolates the
transport, so a future swap to OTLP-over-fetch is a one-file change.

## Data model — Settings

`src/data/settings.ts` gains:

```ts
export interface ObservabilityConfig {
  enabled: boolean            // master beta toggle — default false
  publicKey: string           // pk-lf-…
  secretKey: string           // sk-lf-…  (chrome.storage.local, like provider keys)
  host: string                // default 'https://cloud.langfuse.com'
  captureContent: boolean     // default true  — prompt/response/tool text
  captureScreenshots: boolean // default false — the images sub-toggle
}
// Settings gains:  observability?: ObservabilityConfig
```

`EMPTY` gets a default `observability` with `enabled: false`. Field-level
migration is automatic (spread over defaults), so existing installs stay off.

## Architecture — `src/agent/observability/`

- **`types.ts`** — `Observer`, `Trace`, `Generation`, `Span` interfaces + the
  option/result shapes. `Generation.end({ output?, usageDetails?, model?,
  finishReason?, level?, statusMessage?, metadata? })`, etc.
- **`langfuseClient.ts`** — zero-dep batched ingestion client. Buffers
  `trace-create` / `generation-create|update` / `span-create|update` /
  `event-create` events and POSTs batches to `{host}/api/public/ingestion` with
  `Authorization: Basic base64(pk:sk)`. Flush triggers: short debounce timer,
  buffer-size cap, and explicit `flush()`. IDs via `crypto.randomUUID()`. Every
  network call is wrapped so a Langfuse failure can never surface to the user.
  Batch stays under the 3.5 MB limit (size-based flush).
- **`observer.ts`** — the façade. `getObserver()` returns a live `Observer` when
  `enabled` + keys are present, else a shared **no-op** singleton whose handles
  do nothing. This keeps instrumentation lines permanently at call sites with
  **zero cost and no `if (enabled)` scatter**. `captureContent` /
  `captureScreenshots` are enforced *inside* the live Observer — content is
  nulled before it enters the buffer when disabled; screenshots attach to
  generations only when enabled. Config is loaded once and cached, with a
  `chrome.storage.onChanged` subscription so toggling takes effect without a
  reload. Works in both the side panel and the service worker.
- **`index.ts`** — re-exports.

### Langfuse mapping

- **Session** = conversation id. Groups all of a chat's turns in the Sessions
  view. Chat-scoped background work (title-gen, research, extract launched from a
  chat) reuses the chat's `sessionId`; dreaming has none (tag `dreaming`).
- **Trace** = one top-level operation. **Observations** nest inside:
  - `generation` per model step — `model`, input messages, output text/tool
    calls, `usageDetails` (tokens), `finishReason`, latency.
  - `span` per tool call — input, output/error, timing, approval outcome, and
    the page-control point-of-no-return flag.
  - `event` for approval-gate decisions (shown / allowed / denied / allow-for-chat).

Context is threaded **explicitly** (no AsyncLocalStorage in-browser):
`runAgentTurn` gains an optional `trace?: Trace`; `createAgentTools` gains
`trace?: Trace` in deps. Both no-op when absent.

## Instrumentation surfaces (all 8)

| Surface | File | Trace | Captured |
|---|---|---|---|
| User turn | `ui/Chat.tsx` (runAgentTurn call) | `chat-turn` (session=convId, tag `chat`) | per-step generations, tool spans, approval events, total usage |
| Chat title | `ui/Chat.tsx` / `agent/provider.ts` | `chat-title` | one generation |
| Background research | `agent/research.ts` | `research-task` (session=convId, tag `research`) | nested turn generations + tools |
| Research tool entry | `tools/research.ts` | span under active turn | |
| ExtractData | `agent/extract.ts` | generation under the tool's span | schema, tokens |
| Vision probe | `agent/vision.ts` | `vision-probe` (tag `vision`) | one generation |
| Memory dreaming | `agent/dream.ts` | `dream` (tag `dreaming`, in service worker) | one generation |
| Tool executions | `tools/tools.ts` | spans on the active trace | input/output/error, timing, approval outcome, PONR flag |

Per-step generations come from adding `onStepFinish` / `onFinish` to the
`streamText` call in `agent.ts` (they don't disturb the existing `result.stream`
loop). One-shot surfaces read the awaited `result.usage`. Tool spans wrap each
tool's `execute` in `createAgentTools`.

Token usage maps to `usageDetails` (`input` = inputTokens, `output` =
outputTokens, `total` = totalTokens; plus any cached/reasoning tokens from
`providerMetadata` when present). Cost is computed by Langfuse from its model
price table matched on `model` — the user may need to register prices for custom
model names in Langfuse; we send accurate token counts + model regardless.

## UI — General tab

New "Observability (Beta)" section below Privacy:
- Master toggle (checkbox).
- When on, reveals: Public key, Secret key (type=password), Host (editable),
  "Capture page content" checkbox (default on), "Include screenshots" checkbox
  (default off), and a "Test connection" button that sends one tiny trace ping
  and reports ✓/✗ (mirrors the provider "Test" pattern).
- Same buffer/commit wiring as the other General-tab fields (text buffers on
  keystroke, commits on blur; toggles commit immediately).

## Error handling & robustness

- Observability is strictly non-intrusive: every client call is wrapped in
  try/catch and swallows errors (optional `console.debug`). A Langfuse outage,
  bad key, or CORS issue never breaks a turn.
- No-op handles mean disabled = zero allocation beyond the shared singleton.
- Flush on turn end; best-effort flush before service-worker suspend; flush after
  each dream. `host_permissions: ["<all_urls>"]` already covers reaching Langfuse
  and exempts the calls from CORS.

## Security / privacy

- Secret key stored in `chrome.storage.local`, same model as provider API keys
  (project invariant: keys are runtime-entered, never build-time). It is the
  user's own Langfuse key.
- Content capture honors `captureContent` / `captureScreenshots`; when content is
  off, only metadata (model, tokens, cost, timings, tool names, finish reasons)
  is sent.

## Testing

- Vitest unit tests for: the AI SDK usage → `usageDetails` mapping; the no-op
  Observer (disabled config → no events, no fetch); the client's batching/flush
  against a mocked `fetch`; content-redaction when `captureContent` is false.
- Manual: `npm run build`, reload unpacked extension, run a chat with the toggle
  on against a real Langfuse project, confirm a `chat-turn` trace with nested
  generations + tool spans + token counts appears. (`/verify-extension`.)

## Out of scope (YAGNI)

- User-feedback scores (thumbs) — future.
- Prompt management / linking Langfuse-managed prompts.
- Client-side cost computation for custom models (Langfuse handles it).
- Sending OTLP directly (kept behind the façade for a future swap).
