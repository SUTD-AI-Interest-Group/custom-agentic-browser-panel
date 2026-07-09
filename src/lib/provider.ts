import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText, type LanguageModel } from 'ai'
import type { ProviderConfig } from './settings'

// Any endpoint that speaks the OpenAI chat-completions protocol works here,
// which covers virtually every provider (including local runtimes like
// Ollama and LM Studio). Extension host_permissions bypass CORS, so we can
// call these APIs straight from the side panel — no proxy server.
export function createModel(config: ProviderConfig, modelId: string): LanguageModel {
  const provider = createOpenAICompatible({
    name: config.name,
    baseURL: config.baseURL,
    apiKey: config.apiKey || undefined,
  })
  return provider(modelId)
}

export interface TestResult {
  ok: boolean
  /** The model's reply on success, the error message on failure. */
  message: string
  latencyMs: number
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
