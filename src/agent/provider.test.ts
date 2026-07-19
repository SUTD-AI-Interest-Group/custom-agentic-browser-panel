import { test, expect } from 'vitest'
import { reasoningBodyTransform } from './provider'
import { profileFor } from '../data/providerProfiles'

test('leaves a non-reasoning model with no effort untouched (same ref)', () => {
  const transform = reasoningBodyTransform(profileFor('custom'), undefined, false)
  const body = { model: 'gpt-4o', messages: [] }
  expect(transform(body)).toBe(body)
})

test('a reasoning model with unset effort sends nothing extra', () => {
  const transform = reasoningBodyTransform(profileFor('ollama'), undefined, true)
  expect(transform({ model: 'qwen3', tools: [{}] })).toEqual({ model: 'qwen3', tools: [{}] })
})

test('injects a set reasoning_effort for a compatible reasoning model', () => {
  const transform = reasoningBodyTransform(profileFor('ollama'), 'low', true)
  expect(transform({ model: 'qwen3', tools: [{}] })).toEqual({
    model: 'qwen3',
    tools: [{}],
    reasoning_effort: 'low',
  })
})

test('Groq gets reasoning_format:parsed when tools ride along, even with no effort', () => {
  const transform = reasoningBodyTransform(profileFor('groq'), undefined, true)
  expect(transform({ model: 'deepseek-r1-distill-qwen-32b', tools: [{}] })).toEqual({
    model: 'deepseek-r1-distill-qwen-32b',
    tools: [{}],
    reasoning_format: 'parsed',
  })
})

test('Groq omits reasoning_format when the turn carries no tools', () => {
  const transform = reasoningBodyTransform(profileFor('groq'), 'high', true)
  expect(transform({ model: 'deepseek-r1-distill-qwen-32b' })).toEqual({
    model: 'deepseek-r1-distill-qwen-32b',
    reasoning_effort: 'high',
  })
})

test('OpenRouter sends the reasoning object, never a bare reasoning_effort', () => {
  const transform = reasoningBodyTransform(profileFor('openrouter'), 'high', true)
  const out = transform({ model: 'openai/gpt-5', tools: [{}] })
  expect(out).toMatchObject({ reasoning: { effort: 'high' } })
  expect(out).not.toHaveProperty('reasoning_effort')
})
