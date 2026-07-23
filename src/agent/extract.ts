import { generateObject, generateText, jsonSchema, type LanguageModel } from 'ai'
import { parseJsonLoose } from '../platform/webFetch'
import type { Trace } from './observability'
import { isAbortError } from './resilience'

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
  } catch (err) {
    // A genuine Stop must propagate immediately, not fall through to a second
    // round-trip (generateText below) — that would delay Stop by an extra model
    // call for no benefit, since the caller is already unwinding. Every other
    // failure (no structured-output mode, a schema mismatch, ...) still falls
    // back to prompted JSON.
    if (isAbortError(err)) throw err
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
