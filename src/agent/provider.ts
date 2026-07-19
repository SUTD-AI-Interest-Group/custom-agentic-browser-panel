import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText, type LanguageModel } from 'ai'
import { getObserver } from './observability'
import { sanitizeTitle } from './title'
import type { ProviderConfig, ReasoningEffort } from '../data/settings'

/**
 * Inject an explicit `reasoning_effort` into an outgoing chat-completions body.
 *
 * Reasoning models such as OpenAI's gpt-5.x default `reasoning_effort` to a
 * non-'none' value *server-side* on /v1/chat/completions, and OpenAI then refuses
 * the request the moment it also carries function tools:
 *   "Function tools with reasoning_effort are not supported for <model> in
 *    /v1/chat/completions. ... set reasoning_effort to 'none'."
 * Every agent turn here is tool-driven over chat-completions, so such a model is
 * unusable until we send an explicit effort. It stays opt-in per provider
 * (`ProviderConfig.reasoningEffort`) because the value is model-specific: a
 * non-reasoning model (gpt-4o) rejects the parameter outright, and older reasoning
 * models (o1/o3) reject the 'none' value — so we send nothing unless asked.
 */
export function applyReasoningEffort(
  body: Record<string, unknown>,
  effort: ReasoningEffort | undefined,
): Record<string, unknown> {
  if (!effort) return body
  return { ...body, reasoning_effort: effort }
}

// Any endpoint that speaks the OpenAI chat-completions protocol works here,
// which covers virtually every provider (including local runtimes like
// Ollama and LM Studio). Extension host_permissions bypass CORS, so we can
// call these APIs straight from the side panel — no proxy server.
export function createModel(config: ProviderConfig, modelId: string): LanguageModel {
  const provider = createOpenAICompatible({
    name: config.name,
    baseURL: config.baseURL,
    apiKey: config.apiKey || undefined,
    // Ask for a usage block on STREAMING responses. The adapter only sends
    // `stream_options: { include_usage: true }` when this is set, and without it
    // an OpenAI-compatible endpoint (LM Studio, OpenAI, OpenRouter, Groq, …)
    // streams back no token counts at all — so every streamText turn would report
    // empty usage, and token/cost tracking would silently show zero. Non-streaming
    // generateText calls return usage regardless, which is why only chat turns
    // were affected. Endpoints that don't understand stream_options ignore it.
    includeUsage: true,
    // Pin reasoning_effort when the user configured one for this provider — the
    // only channel the openai-compatible adapter leaves for it. See
    // applyReasoningEffort: without this, a gpt-5.x reasoning model can't run the
    // agent's function tools on /v1/chat/completions. Unset → body untouched.
    transformRequestBody: (body) => applyReasoningEffort(body, config.reasoningEffort),
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
