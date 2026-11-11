import { test, expect, vi } from 'vitest'
import { parseModelList, fetchModelList } from './modelList'

test('parses the OpenAI-shaped list (OpenAI / Groq / custom / LM Studio)', () => {
  const json = { object: 'list', data: [{ id: 'gpt-4o' }, { id: 'gpt-5.6-luna' }] }
  expect(parseModelList('openai', json)).toEqual([{ id: 'gpt-4o' }, { id: 'gpt-5.6-luna' }])
})

test('parses the Ollama /api/tags shape (name field, models envelope)', () => {
  const json = { models: [{ name: 'qwen3:8b' }, { name: 'llama3.1' }] }
  expect(parseModelList('ollama', json)).toEqual([{ id: 'qwen3:8b' }, { id: 'llama3.1' }])
})

test('reads OpenRouter reasoning capability from supported_parameters', () => {
  const json = {
    data: [
      { id: 'openai/gpt-5', supported_parameters: ['tools', 'reasoning'] },
      { id: 'meta/llama-3', supported_parameters: ['tools'] },
    ],
  }
  expect(parseModelList('openrouter', json)).toEqual([
    { id: 'openai/gpt-5', reasoning: true },
    { id: 'meta/llama-3', reasoning: false },
  ])
})

test('reads Anthropic reasoning capability from the capabilities tree', () => {
  const json = {
    data: [{ id: 'claude-opus-4-8', capabilities: { thinking: { types: { adaptive: { supported: true } } } } }],
  }
  expect(parseModelList('anthropic', json)).toEqual([{ id: 'claude-opus-4-8', reasoning: true }])
})

test('dedupes ids and skips malformed rows', () => {
  const json = { data: [{ id: 'a' }, { id: 'a' }, { notId: 'b' }, null, { id: '' }] }
  expect(parseModelList('openai', json)).toEqual([{ id: 'a' }])
})

test('returns [] for an unexpected shape rather than throwing', () => {
  expect(parseModelList('openai', { oops: true })).toEqual([])
  expect(parseModelList('openai', null)).toEqual([])
})

test('owner cancellation aborts a pending model discovery request', async () => {
  const controller = new AbortController()
  vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  })))
  try {
    const pending = fetchModelList({ id: 'local', name: 'Local', kind: 'custom', baseURL: 'http://127.0.0.1:1234/v1', apiKey: '', models: [] }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  } finally { vi.unstubAllGlobals() }
})
