import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { defaultSettingsMiddleware, generateText, wrapLanguageModel, type LanguageModel } from 'ai'
import { getObserver } from './observability'
import { sanitizeTitle } from './title'
import { providerKind, resolveReasoningEffort, type ProviderConfig, type ReasoningEffort } from '../data/settings'
import { isReasoningModel, profileFor, type ProviderProfile } from '../data/providerProfiles'

/**
 * The `transformRequestBody` a compatible provider uses to inject its reasoning
 * fields. Pure and exported so the gating and tool-awareness are unit-testable
 * without standing up an adapter:
 *  - a non-reasoning model with no effort set is left untouched (the original
 *    contract — nothing extra is sent), and
 *  - a reasoning model's fields come from its profile, which is what lets Groq add
 *    `reasoning_format: 'parsed'` whenever tools ride along (raw + tools = 400).
 */
export function reasoningBodyTransform(
  profile: ProviderProfile,
  effort: ReasoningEffort | undefined,
  reasoning: boolean,
): (body: Record<string, unknown>) => Record<string, unknown> {
  return (body) => {
    if (!reasoning && effort === undefined) return body
    const tools = body.tools
    const hasTools = Array.isArray(tools) && tools.length > 0
    return { ...body, ...profile.reasoningBody!(effort, hasTools) }
  }
}

/**
 * Bake a native provider's reasoning options onto the model via middleware, so
 * every call carries them without threading `providerOptions` through call sites.
 * A no-op when there is nothing to inject (unset effort → the endpoint's default).
 */
function withReasoningOptions(
  model: Parameters<typeof wrapLanguageModel>[0]['model'],
  providerName: 'openai' | 'anthropic',
  options: Record<string, unknown>,
): LanguageModel {
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
    return withReasoningOptions(model, 'anthropic', reasoning ? profile.reasoningOptions!(effort) : {})
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
  const observer = getObserver()
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
