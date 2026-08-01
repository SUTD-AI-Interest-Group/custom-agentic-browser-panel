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

  it('rethrows when the generateText fallback also fails (no third tier)', async () => {
    generateObjectMock.mockRejectedValue(new Error('no structured-output mode'))
    const textErr = new Error('endpoint unreachable')
    generateTextMock.mockRejectedValue(textErr)

    await expect(extractStructured(MODEL, 'prompt', SCHEMA)).rejects.toBe(textErr)
  })

  it('rethrows when the fallback text is not parseable as JSON', async () => {
    generateObjectMock.mockRejectedValue(new Error('no structured-output mode'))
    generateTextMock.mockResolvedValue({ text: 'sorry, I cannot help with that', usage: {} })

    await expect(extractStructured(MODEL, 'prompt', SCHEMA)).rejects.toThrow()
  })
})
