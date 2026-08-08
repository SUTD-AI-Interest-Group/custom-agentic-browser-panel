import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import {
  defaultSettingsMiddleware,
  generateText,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from 'ai'
import { getObserver } from './observability'
import { sanitizeTitle } from './title'
import { LYCHEE_PROVIDER_OPTIONS_NS } from './agent'
import {
  providerKind,
  resolveReasoningEffort,
  loadSettings,
  observabilityConfig,
  type ObservabilityConfig,
  type ProviderConfig,
  type ReasoningEffort,
} from '../data/settings'
import { isReasoningModel, profileFor, type ProviderProfile } from '../data/providerProfiles'

/**
 * The `transformRequestBody` a compatible provider uses to inject its reasoning
 * fields. Pure and exported so the gating and tool-awareness are unit-testable
 * without standing up an adapter:
 *  - a non-reasoning model is left untouched (the original contract — nothing
 *    extra is sent), regardless of `effort`, and
 *  - a reasoning model's fields come from its profile, which is what lets Groq add
 *    `reasoning_format: 'parsed'` whenever tools ride along (raw + tools = 400).
 *
 * Gated purely on `reasoning`, matching the native-adapter path below (d01 F1):
 * `effort` is not a safe signal on its own. It resolves from a *provider-wide*
 * default (the Providers tab's "Reasoning effort" dropdown, `settings.ts`'s
 * `provider.reasoningEffort`) independently of whether the model THIS call is
 * for is a reasoning model at all. A user who sets that default while on a
 * reasoning model, then switches to (or titleModel/dreamModel independently
 * resolves to) a plain model on the same provider, leaves `effort` defined
 * even though `reasoning` is correctly false for the new model — the old
 * `!reasoning && effort === undefined` gate let that stale effort inject
 * `reasoning_effort`/`reasoning_format` into a request for a model explicitly
 * classified non-reasoning (Groq 400s outright on the unexpected field).
 */
export function reasoningBodyTransform(
  profile: ProviderProfile,
  effort: ReasoningEffort | undefined,
  reasoning: boolean,
): (body: Record<string, unknown>) => Record<string, unknown> {
  return (body) => {
    if (!reasoning) return body
    const tools = body.tools
    const hasTools = Array.isArray(tools) && tools.length > 0
    return { ...body, ...profile.reasoningBody!(effort, hasTools) }
  }
}

/** The narrower model type `wrapLanguageModel` actually accepts/returns — as
 *  opposed to `LanguageModel`, the broad exported union that also allows a
 *  bare model-id string (for registry-based lookups elsewhere in the SDK).
 *  `createModel` never deals in that string form, so functions that may need
 *  to re-wrap their own output (chaining `withReasoningOptions` into
 *  `withCacheControl`) are typed on this instead. */
type ModelInput = Parameters<typeof wrapLanguageModel>[0]['model']

/**
 * Bake a native provider's reasoning options onto the model via middleware, so
 * every call carries them without threading `providerOptions` through call sites.
 * A no-op when there is nothing to inject (unset effort → the endpoint's default).
 */
function withReasoningOptions(
  model: ModelInput,
  providerName: 'openai' | 'anthropic',
  options: Record<string, unknown>,
): ModelInput {
  if (Object.keys(options).length === 0) return model
  return wrapLanguageModel({
    model,
    // The profile's options are JSON-safe by construction; the cast bridges the
    // profile's Record<string, unknown> to the SDK's JSONObject-valued settings type.
    middleware: defaultSettingsMiddleware({
      settings: { providerOptions: { [providerName]: options } },
    } as Parameters<typeof defaultSettingsMiddleware>[0]),
  })
}

/**
 * Anthropic-only: mark the turn's system prompt as an ephemeral prompt-cache
 * breakpoint. A no-op call site: `createModel` only ever invokes this from the
 * `adapter === 'anthropic'` branch (gated additionally on
 * `profile.supportsPromptCaching`), so it never reaches the native OpenAI or
 * OpenAI-compatible paths — no risk of leaking an Anthropic-only field into a
 * request an arbitrary compatible endpoint would 400 on.
 *
 * Placement: the (single) system-role message in the call's prompt array, not
 * the Anthropic API's call-level "top-level auto-cache" convenience
 * (`providerOptions.anthropic.cacheControl` set at the CALL level rather than
 * per-message, which the `@ai-sdk/anthropic` adapter forwards as a bare
 * top-level `cache_control` field on the request body). That convenience
 * auto-places its ONE breakpoint on the last cacheable block of the WHOLE
 * request — tools, then system, then messages — so on a turn whose message
 * history keeps growing (every step of a 24-step turn, every round of a
 * research task) the marker would land on the volatile tail and re-write
 * instead of read on every single call. Marking the system block explicitly
 * matches the documented placement pattern for "large system prompt shared
 * across many requests" (tools render before system, so caching a system
 * block caches both together).
 *
 * A marked block is a byte-for-byte match with NO partial credit inside it —
 * so if `runAgentTurn` ever handed this model ONE system message combining
 * genuinely volatile content (recalled memories, an invoked skill's body, a
 * retry note) with stable content, marking that whole message would miss the
 * cache on every turn the volatile part changed, i.e. every turn, for a
 * 1.25x write premium each time with no offsetting read. `runAgentTurn`
 * (`agent.ts`) therefore tags a combined message with
 * `providerOptions.lychee.volatileSystemLength` — how many trailing
 * characters are the volatile suffix — whenever it has one. This middleware
 * reads that hint and, when present, SPLITS the one incoming message into
 * two wire blocks: `stable` (marked, cacheable) and `volatile` (unmarked, a
 * fresh uncached read every time). The stable prefix then stays cache-live
 * across every turn AND across different conversations on the same install
 * that share the same stable prompt — even a single-step "just chat" turn
 * now gets read-priced (~0.1x) against whatever the LAST turn (any
 * conversation) wrote, rather than always paying the write premium alone.
 * Callers with no hint (a plain string `system` — research.ts's fixed phase
 * prompts, title-gen, dream) fall through to marking the whole (only) system
 * message, unchanged from before this split existed.
 */
const withCacheControl: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    const prompt = params.prompt
    for (let i = 0; i < prompt.length; i++) {
      const msg = prompt[i]
      if (msg.role !== 'system') continue
      const hint = msg.providerOptions?.[LYCHEE_PROVIDER_OPTIONS_NS] as
        | { volatileSystemLength?: number }
        | undefined
      const volatileLength = hint?.volatileSystemLength ?? 0
      // Drop the app-internal hint either way — its job is done once read
      // here, and no provider adapter should see an unrecognized namespace
      // key rely on it (harmless either way, since adapters only read their
      // own namespace, but there's nothing to gain by forwarding it).
      const { [LYCHEE_PROVIDER_OPTIONS_NS]: _hint, ...restProviderOptions } = msg.providerOptions ?? {}
      const nextPrompt = [...prompt]
      if (volatileLength > 0 && volatileLength < msg.content.length) {
        const stable = msg.content.slice(0, msg.content.length - volatileLength)
        const volatile = msg.content.slice(msg.content.length - volatileLength)
        nextPrompt.splice(
          i,
          1,
          {
            ...msg,
            content: stable,
            providerOptions: { ...restProviderOptions, anthropic: { cacheControl: { type: 'ephemeral' } } },
          },
          { role: 'system', content: volatile },
        )
      } else {
        nextPrompt[i] = {
          ...msg,
          providerOptions: {
            ...restProviderOptions,
            anthropic: { ...msg.providerOptions?.anthropic, cacheControl: { type: 'ephemeral' } },
          },
        }
      }
      return { ...params, prompt: nextPrompt }
    }
    // No system message this call (e.g. generateChatTitle/testModel, which pass
    // only `prompt`) — nothing to mark, leave the call untouched.
    return params
  },
}

/**
 * Build a LanguageModel for a (provider, model) pair, dispatching on the provider's
 * capability profile (`src/data/providerProfiles.ts`):
 *  - `openai`    → the native **Responses API**, the only path where reasoning and
 *                  function tools coexist (chat-completions 400s that combination);
 *  - `anthropic` → the native **Messages API** (native thinking);
 *  - everything else → the OpenAI-compatible adapter (Groq, Ollama, LM Studio,
 *                  OpenRouter, or a custom endpoint).
 * Reasoning is resolved once here from the model's effective effort and injected
 * per profile — native via `providerOptions` middleware, compatible via a body
 * transform. Extension host_permissions bypass CORS, so every call goes straight
 * from the side panel — no proxy, keys never leave the browser.
 *
 * Anthropic models additionally get an ephemeral cache_control breakpoint on
 * their system prompt (`withCacheControl`, gated on `profile.supportsPromptCaching`)
 * — every caller of this function shares one model per (provider, model) build,
 * so a turn's up-to-24 steps, a research task's phases, and the browse
 * sub-agent's steps all reuse the same wrapped model and all benefit.
 */
export function createModel(config: ProviderConfig, modelId: string): LanguageModel {
  const profile = profileFor(providerKind(config))
  const effort = resolveReasoningEffort(config, modelId)
  const reasoning = isReasoningModel(config, modelId)
  const apiKey = config.apiKey || undefined

  if (profile.adapter === 'openai') {
    const model = createOpenAI({ baseURL: config.baseURL, apiKey }).responses(modelId)
    return withReasoningOptions(model, 'openai', reasoning ? profile.reasoningOptions!(effort) : {})
  }

  if (profile.adapter === 'anthropic') {
    // The dangerous-direct-browser-access header is what lets Anthropic's API be
    // called straight from the extension origin (the same CORS-free path the compat
    // layer used); the key still never leaves the browser.
    const model = createAnthropic({
      baseURL: config.baseURL,
      apiKey,
      headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
    })(modelId)
    const withReasoning = withReasoningOptions(model, 'anthropic', reasoning ? profile.reasoningOptions!(effort) : {})
    return profile.supportsPromptCaching
      ? wrapLanguageModel({ model: withReasoning, middleware: withCacheControl })
      : withReasoning
  }

  const provider = createOpenAICompatible({
    name: config.name,
    baseURL: config.baseURL,
    apiKey,
    // Ask for a usage block on STREAMING responses. Without it an OpenAI-compatible
    // endpoint streams back no token counts, so every streamText turn would report
    // empty usage and token/cost tracking would silently show zero. Non-streaming
    // generateText returns usage regardless. Endpoints that don't understand it ignore it.
    includeUsage: true,
    transformRequestBody: reasoningBodyTransform(profile, effort, reasoning),
  })
  return provider(modelId)
}

export interface TestResult {
  ok: boolean
  /** The model's reply on success, the error message on failure. */
  message: string
  latencyMs: number
}

/**
 * Read the observability config straight from storage instead of trusting
 * `observer.ts`'s module-level cache, which starts at the disabled default and
 * is only overwritten once its own fire-and-forget `refresh()` (a
 * chrome.storage round trip kicked off at import time) resolves. A no-arg
 * `getObserver()` call landing before that resolves — routine right after a
 * fresh side-panel load or a service-worker wake, exactly when a brand-new
 * chat's first title-gen or a cold model's first vision probe fires — would
 * silently look disabled even when the user has it configured (d14 F12).
 * `dream.ts`/`research.ts` avoid this by loading Settings for other reasons
 * and passing the config through explicitly; title-gen and the vision probe
 * (vision.ts, which shares this helper) don't otherwise need Settings, so this
 * loads it just for this. Best-effort: any failure (storage hiccup) falls
 * through to `getObserver()`'s own cached default rather than breaking the
 * caller — this is observability, it must never be why a title or a probe fails.
 */
export async function currentObservabilityConfig(): Promise<ObservabilityConfig | undefined> {
  try {
    return observabilityConfig(await loadSettings())
  } catch {
    return undefined
  }
}

/**
 * How long the namer may take. Generous on purpose: nobody waits on this call —
 * it runs in the background after the turn — while a *reasoning* model routinely
 * spends 12–25s and ~2k tokens of chain-of-thought to produce four words. The
 * previous 20s ceiling sat squarely inside that spread, so titles aborted on
 * roughly half of all chats; because a failed title used to be permanent, those
 * chats read "New chat" forever. Pick a small non-reasoning `titleModel` in
 * Settings to make this ~1s instead.
 */
const TITLE_TIMEOUT_MS = 60_000

/**
 * Names a chat from its opening message via a side-call to the title model.
 * Returns null (and never throws) if the model is unavailable or slow. A null is
 * not terminal: the caller retries on the chat's next turn while it is still
 * untitled.
 */
export async function generateChatTitle(
  model: LanguageModel,
  firstMessage: string,
  /** Conversation id, so the title generation joins the chat's Langfuse session. */
  sessionId?: string,
): Promise<string | null> {
  const observer = getObserver(await currentObservabilityConfig())
  const trace = observer.enabled
    ? observer.startTrace({ name: 'chat-title', sessionId, tags: ['title'], input: firstMessage })
    : undefined
  const gen = trace?.generation({
    name: 'chat-title',
    model: (model as { modelId?: string }).modelId,
    input: firstMessage,
  })
  try {
    const { text, usage } = await generateText({
      model,
      prompt:
        'Write a concise title (3–6 words, Title Case, no quotes, no trailing punctuation) for a ' +
        'chat that begins with this message. Reply with the title only.\n\n' +
        `Message: ${firstMessage.slice(0, 500)}`,
      abortSignal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
    })
    const title = sanitizeTitle(text)
    gen?.end({ output: title, usage })
    trace?.end({ output: title })
    void observer.flush()
    return title
  } catch (err) {
    gen?.end({ level: 'ERROR', statusMessage: err instanceof Error ? err.message : String(err) })
    trace?.end()
    void observer.flush()
    return null
  }
}

/** Fires one tiny completion at the endpoint to prove the config works. */
export async function testModel(config: ProviderConfig, modelId: string): Promise<TestResult> {
  const started = Date.now()
  try {
    const { text } = await generateText({
      model: createModel(config, modelId),
      prompt: 'Reply with the single word: ready',
      abortSignal: AbortSignal.timeout(20_000),
    })
    return { ok: true, message: text.trim().slice(0, 100), latencyMs: Date.now() - started }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    }
  }
}
