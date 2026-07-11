import { generateObject, generateText, jsonSchema, type LanguageModel } from 'ai'
import { parseJsonLoose } from '../platform/webFetch'

/**
 * Extract a JSON value matching `schema` (a JSON Schema object) from `prompt`.
 * Tries the endpoint's structured-output mode; on failure (endpoints without
 * it) falls back to prompted JSON + tolerant parse. Returns the value or throws.
 * `schema` is passed declaratively via jsonSchema() — never eval'd (CSP).
 */
export async function extractStructured(
  model: LanguageModel,
  prompt: string,
  schema: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    const { object } = await generateObject({ model, schema: jsonSchema(schema as any), prompt, abortSignal: signal })
    return object
  } catch {
    const { text } = await generateText({
      model,
      prompt: `${prompt}\n\nReturn ONLY JSON matching this schema:\n${JSON.stringify(schema)}`,
      abortSignal: signal,
    })
    return parseJsonLoose(text)
  }
}
