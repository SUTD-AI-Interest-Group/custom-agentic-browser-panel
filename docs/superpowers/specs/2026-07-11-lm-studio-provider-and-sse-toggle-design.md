# LM Studio preset + per-provider SSE toggle — design

## Problem

Two gaps in provider configuration:

1. **No LM Studio preset.** The one-click preset row (Onboarding + Settings) lists
   OpenAI, Anthropic, OpenRouter, Groq, Ollama, and Custom — but not LM Studio,
   even though it is one of the most common local OpenAI-compatible runtimes.
   Users have to reach for "Custom" and remember the endpoint.

2. **No way to disable streaming for a provider.** The agent turn always calls
   `streamText`, which sends `stream: true` to the endpoint. Some endpoints and
   proxies (in some setups, LM Studio among them) error or hang on streaming
   chat-completions requests. There is no escape hatch: if an endpoint can't do
   SSE, the panel is unusable with it.

## Goal

- Add **LM Studio (local)** as a preset in both preset rows.
- Add a **per-provider "Streaming (SSE)" toggle**. When off, every model call to
  that provider is a genuinely non-streaming request (`stream: false`). The reply
  then lands in the UI all at once instead of token-by-token; tools and multi-step
  turns keep working.

The toggle is a transport-level switch, not merely a UI-rendering preference —
the whole point is endpoints that break on `stream: true`.

## What already exists (reused, not rebuilt)

- `src/data/settings.ts` — `ProviderConfig { id, name, baseURL, apiKey, models }`,
  persisted in `chrome.storage.local`. `loadSettings()` already merges stored
  settings over an `EMPTY` default, so a newly-added optional field migrates
  cleanly on old installs.
- `src/agent/provider.ts` — `createModel(config, modelId)` builds the model via
  `createOpenAICompatible(...)`. This is the single choke point every model call
  flows through (turn loop, `testModel`, `generateChatTitle`, plus `vision.ts`
  and `dream.ts` construct models the same way).
- `src/agent/agent.ts` — `runAgentTurn` drives the multi-step loop with
  `streamText`, consuming `result.stream` and pushing `UIPart[]` to the UI via
  `onUpdate`. **Unchanged by this design.**
- `src/ui/Onboarding.tsx` and `src/ui/settings/GeneralTab.tsx` — each holds its
  own `PRESETS` array and an "add provider" path.
- `src/ui/styles.css` — `.switch` (`:1471`), a `<input type="checkbox">` styled as
  a sliding on/off toggle, already used by the tools quick-menu. Reused as-is.
- `ai` v7 exports `wrapLanguageModel` and `simulateStreamingMiddleware`
  (verified in the installed package).

## Design

### 1. Data model — `ProviderConfig.streaming`

Add one optional field to `ProviderConfig` in `src/data/settings.ts`:

```ts
export interface ProviderConfig {
  id: string
  name: string
  baseURL: string
  apiKey: string
  /** Model ids offered by this provider, one per entry. */
  models: string[]
  /**
   * Whether to stream responses (SSE, `stream: true`) from this endpoint.
   * Absent/`true` = stream (default). `false` = every call is non-streaming
   * (`stream: false`) for endpoints/proxies that break on streaming requests.
   */
  streaming?: boolean
}
```

`undefined` means stream — so existing providers and the current behavior are
unchanged, and no migration code is needed. Only an explicit `false` disables SSE.

### 2. Provider adapter — wrap when streaming is off

In `src/agent/provider.ts`, `createModel` wraps the model with
`simulateStreamingMiddleware` when the provider opted out of streaming:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
  generateText,
  wrapLanguageModel,
  simulateStreamingMiddleware,
  type LanguageModel,
} from 'ai'

export function createModel(config: ProviderConfig, modelId: string): LanguageModel {
  const provider = createOpenAICompatible({
    name: config.name,
    baseURL: config.baseURL,
    apiKey: config.apiKey || undefined,
  })
  const model = provider(modelId)
  // Some endpoints/proxies break on streaming requests. simulateStreamingMiddleware
  // overrides only the stream path: it calls the model's non-streaming doGenerate
  // (stream:false) and synthesizes a stream from the full result. So streamText in
  // the turn loop keeps working untouched — every underlying HTTP call is just
  // non-streaming, and the reply arrives in one delta.
  if (config.streaming === false) {
    return wrapLanguageModel({ model, middleware: simulateStreamingMiddleware() })
  }
  return model
}
```

Why this works with no turn-loop change: `simulateStreamingMiddleware()` only
overrides `wrapStream` (calls `doGenerate()`, then emits the result as a
one-shot simulated stream). The `generate` path passes through untouched, so
`generateText` callers (`testModel`, `generateChatTitle`, `vision.ts`,
`dream.ts`) are unaffected — they already run non-streaming and never hit the
stream path. Multi-step tool loops, `prepareStep` image injection, and
`repairToolCall` continue to work because the turn still runs through
`streamText`; only each step's underlying request flips to `stream: false`.

### 3. UI — per-provider toggle in Settings

In `src/ui/settings/GeneralTab.tsx`, add a "Streaming (SSE)" row to each
`.provider-card`, after the Models field, reusing the `.switch` checkbox:

```tsx
<label className="provider-stream-row">
  <span>Streaming (SSE)</span>
  <input
    type="checkbox"
    className="switch"
    checked={p.streaming !== false}
    onChange={(e) => updateProvider(p.id, { streaming: e.target.checked })}
  />
</label>
```

- Checked when `streaming !== false` (so unset reads as on).
- Toggling writes `streaming: true | false` explicitly via the existing
  `updateProvider` path — a structural change that persists like the other
  provider fields. A short hint sits under it: "Turn off if this endpoint errors
  or hangs on streaming requests."
- A minimal `.provider-stream-row` rule (label text left, switch right) is added
  to `styles.css` if the existing row layout doesn't already handle it.

Onboarding does **not** expose the toggle (v1 scope): it adds a single provider
via preset; the toggle lives one screen away in Settings. (Explicitly out of
scope — see below.)

### 4. LM Studio preset

Add LM Studio to both preset arrays, defaulting to **streaming on** (no
`streaming` field set — consistent with the other presets; the toggle is the
escape hatch for setups that break).

- `src/ui/Onboarding.tsx` `PRESETS`:
  `{ name: 'LM Studio (local)', baseURL: 'http://localhost:1234/v1', placeholderModel: 'model-id', keyHint: 'not needed' }`
  (placed next to the Ollama local entry).
- `src/ui/settings/GeneralTab.tsx` `PRESETS`:
  `{ name: 'LM Studio (local)', baseURL: 'http://localhost:1234/v1', models: [] }`.

LM Studio serves whatever model the user has loaded; `models` is left empty (like
OpenRouter/Groq) and the placeholder guides the user to fill in their loaded
model id.

## Data flow

```
Settings → GeneralTab toggle ──► ProviderConfig.streaming (chrome.storage.local)
                                          │
                        selected provider │
                                          ▼
                              createModel(config, modelId)
                                          │
                    streaming === false?  │  yes → wrapLanguageModel(+simulateStreamingMiddleware)
                                          │  no/unset → bare model
                                          ▼
                          runAgentTurn → streamText  (unchanged)
                                          │
                       endpoint request:  stream:false (wrapped) | stream:true (bare)
```

## Error handling

- No new failure modes. A wrapped model that errors surfaces the error exactly as
  today (through `streamText`'s stream, caught by the existing turn error path).
- If a user turns SSE off on an endpoint that *did* work streaming, behavior is
  still correct — just non-streamed. There is no invalid combination.
- Existing installs: `streaming` absent → treated as on → identical to today.

## Testing / verification

No test suite (per CLAUDE.md). Verify via `npm run build` then the
`/verify-extension` flow:

1. Settings → add the **LM Studio (local)** preset; confirm it appears with
   `http://localhost:1234/v1` and no key.
2. Toggle **Streaming (SSE)** off on a provider; confirm the switch state
   persists across a settings reopen.
3. With streaming **on**, run a turn and confirm token-by-token streaming still
   works (regression check).
4. With streaming **off**, run a turn against an endpoint and confirm the reply
   arrives in one shot and that a multi-step tool turn still completes; confirm
   via network inspection (or a known SSE-breaking endpoint) that the request was
   non-streaming.

## Out of scope (YAGNI)

- No SSE toggle in Onboarding — Settings only for v1.
- No auto-detection / fallback from streaming to non-streaming on error — the
  toggle is manual.
- No change to `runAgentTurn`, the vision probe, dreaming, or title generation.
- LM Studio preset does not force streaming off.
