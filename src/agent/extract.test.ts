import { beforeEach, describe, expect, it, vi } from 'vitest'

// extractStructured's two-tier fallback (generateObject -> generateText +
// parseJsonLoose) and its abort-must-propagate-immediately short-circuit had
// zero coverage. Mock only generateObject/generateText from 'ai' — everything
// else (jsonSchema, types) rides through the real module.
const generateObjectMock = vi.fn()
const generateTextMock = vi.fn()

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateObject: (...args: unknown[]) => generateObjectMock(...args),
    generateText: (...args: unknown[]) => generateTextMock(...args),
  }
})

import { extractStructured } from './extract'
import { StructuredOutputError } from './resilience'

const MODEL = {} as Parameters<typeof extractStructured>[0]
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } }

beforeEach(() => {
  generateObjectMock.mockReset()
  generateTextMock.mockReset()
})

describe('extractStructured', () => {
  it('returns the object directly when generateObject succeeds, without falling back', async () => {
    generateObjectMock.mockResolvedValue({ object: { ok: true }, usage: { inputTokens: 1 } })

    const result = await extractStructured(MODEL, 'prompt', SCHEMA)

    expect(result).toEqual({ ok: true })
    expect(generateTextMock).not.toHaveBeenCalled()
  })

  it('falls back to prompted JSON + tolerant parse when generateObject fails for a non-abort reason', async () => {
    // e.g. the endpoint has no structured-output mode.
    generateObjectMock.mockRejectedValue(new Error('400 unsupported_parameter: response_format'))
    generateTextMock.mockResolvedValue({ text: '```json\n{"ok":true}\n```', usage: { inputTokens: 1 } })

    const result = await extractStructured(MODEL, 'prompt', SCHEMA)

    expect(result).toEqual({ ok: true })
    expect(generateTextMock).toHaveBeenCalledTimes(1)
    // The fallback prompt still carries the schema, so a compat endpoint has
    // something concrete to match against.
    const fallbackPrompt = generateTextMock.mock.calls[0][0].prompt as string
    expect(fallbackPrompt).toContain('prompt')
    expect(fallbackPrompt).toContain(JSON.stringify(SCHEMA))
  })

  it('a genuine abort from generateObject propagates immediately, without attempting the generateText fallback', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    generateObjectMock.mockRejectedValue(abortErr)

    await expect(extractStructured(MODEL, 'prompt', SCHEMA)).rejects.toBe(abortErr)
    expect(generateTextMock).not.toHaveBeenCalled()
  })

  it('rethrows when the generateText fallback also fails (no third tier), preserving its shape untouched', async () => {
    generateObjectMock.mockRejectedValue(new Error('no structured-output mode'))
    // A real request failure (status-bearing, like a 503) from generateText itself
    // is NOT a "model can't do structured output" signal — it must reach the
    // caller as-is so classifyError can classify it by its own status, and a
    // genuinely transient failure here still retries.
    const textErr = Object.assign(new Error('endpoint unreachable'), { statusCode: 503 })
    generateTextMock.mockRejectedValue(textErr)

    await expect(extractStructured(MODEL, 'prompt', SCHEMA)).rejects.toBe(textErr)
  })

  it('throws a typed StructuredOutputError (not the raw parse error) when the fallback text is not parseable as JSON', async () => {
    // This is the regression case: generateObject fails (no structured-output
    // support), AND the prompted-JSON fallback's own reply still isn't valid
    // JSON. Both structured-output paths are now exhausted — a capability
    // failure, not bad luck — so this must be a recognizable typed error rather
    // than parseJsonLoose's bare, no-status `Error('no JSON found in text')`,
    // which resilience.ts's classifyError could not otherwise tell apart from a
    // genuinely transient failure.
    generateObjectMock.mockRejectedValue(new Error('no structured-output mode'))
    generateTextMock.mockResolvedValue({ text: 'sorry, I cannot help with that', usage: {} })

    await expect(extractStructured(MODEL, 'prompt', SCHEMA)).rejects.toBeInstanceOf(StructuredOutputError)
  })
})
