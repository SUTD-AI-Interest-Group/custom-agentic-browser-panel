import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText, type LanguageModel } from 'ai'
import { getObserver } from './observability'
import type { ProviderConfig } from '../data/settings'

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
 * Names a chat from its opening message via a quick side-call to the same
 * model. Returns null (and never throws) if the model is unavailable or slow,
 * so the caller can simply leave the chat titled "New chat".
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
      abortSignal: AbortSignal.timeout(20_000),
    })
    const title = text
      .trim()
      .split('\n')[0]
      .replace(/^["'“”]+|["'“”.]+$/g, '')
      .trim()
      .slice(0, 60)
    gen?.end({ output: title, usage })
    trace?.end({ output: title })
    void observer.flush()
    return title || null
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
