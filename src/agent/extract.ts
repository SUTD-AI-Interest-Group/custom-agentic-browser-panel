import { generateObject, generateText, jsonSchema, type LanguageModel } from 'ai'
import { parseJsonLoose } from '../platform/webFetch'
import type { Trace } from './observability'

/**
 * Extract a JSON value matching `schema` (a JSON Schema object) from `prompt`.
 * Tries the endpoint's structured-output mode; on failure (endpoints without
 * it) falls back to prompted JSON + tolerant parse. Returns the value or throws.
 * `schema` is passed declaratively via jsonSchema() — never eval'd (CSP).
 *
 * When a `trace` is supplied the underlying model call is recorded as a Langfuse
 * `extract` generation (with token usage); the parent tool span is emitted by
 * the instrumented toolset.
 */
export async function extractStructured(
  model: LanguageModel,
  prompt: string,
  schema: Record<string, unknown>,
  signal?: AbortSignal,
  trace?: Trace,
): Promise<unknown> {
  const gen = trace?.generation({
    name: 'extract',
    model: (model as { modelId?: string }).modelId,
    input: prompt,
  })
  try {
    const { object, usage } = await generateObject({
      model,
      schema: jsonSchema(schema as any),
      prompt,
      abortSignal: signal,
    })
    gen?.end({ output: object, usage })
    return object
  } catch {
    // Endpoint has no structured-output mode — fall back to prompted JSON below.
  }
  try {
    const { text, usage } = await generateText({
      model,
      prompt: `${prompt}\n\nReturn ONLY JSON matching this schema:\n${JSON.stringify(schema)}`,
      abortSignal: signal,
    })
    const parsed = parseJsonLoose(text)
    gen?.end({ output: text, usage })
    return parsed
  } catch (err) {
    gen?.end({ level: 'ERROR', statusMessage: err instanceof Error ? err.message : String(err) })
    throw err
  }
}
