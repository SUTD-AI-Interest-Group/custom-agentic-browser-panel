import { expect, test } from 'vitest'
import { applyPreset, hasValidEndpointScheme, type OnboardingDraft } from './Onboarding'

// Obvious placeholder — never a real-looking secret in a test fixture.
const PLACEHOLDER_KEY = 'PLACEHOLDER_KEY_TYPED_FOR_OPENAI_PRESET'

function draftAfter(apiKey: string): OnboardingDraft {
  return {
    presetName: 'OpenAI',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKey,
    modelId: 'gpt-4o-mini',
  }
}

// Regression test for the CRITICAL finding: a key typed for one preset must
// never survive a switch to a different preset's endpoint.
test('switching presets clears the previously typed API key', () => {
  const next = applyPreset(draftAfter(PLACEHOLDER_KEY), {
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com/v1',
  })
  expect(next.apiKey).toBe('')
})

test('switching to Custom also clears the API key and blanks the name', () => {
  const next = applyPreset(draftAfter(PLACEHOLDER_KEY), { name: 'Custom', baseURL: '' })
  expect(next.apiKey).toBe('')
  expect(next.name).toBe('')
  expect(next.baseURL).toBe('')
})

test('switching away from Custom to a named preset sets name to the preset name', () => {
  const customDraft: OnboardingDraft = {
    presetName: 'Custom',
    name: '',
    baseURL: 'https://my-endpoint.example/v1',
    apiKey: PLACEHOLDER_KEY,
    modelId: 'local-model',
  }
  const next = applyPreset(customDraft, { name: 'Groq', baseURL: 'https://api.groq.com/openai/v1' })
  expect(next.name).toBe('Groq')
  expect(next.apiKey).toBe('')
})

test('baseURL and modelId are always replaced by the preset, never merged', () => {
  const next = applyPreset(draftAfter(PLACEHOLDER_KEY), {
    name: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
  })
  expect(next.baseURL).toBe('https://api.groq.com/openai/v1')
  expect(next.modelId).toBe('')
  expect(next.presetName).toBe('Groq')
})

test('re-picking the same preset still clears the key (no reliance on presetName having changed)', () => {
  const next = applyPreset(draftAfter(PLACEHOLDER_KEY), {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
  })
  expect(next.apiKey).toBe('')
})

test('accepts http and https endpoint schemes', () => {
  expect(hasValidEndpointScheme('https://api.openai.com/v1')).toBe(true)
  expect(hasValidEndpointScheme('http://localhost:11434/v1')).toBe(true)
  expect(hasValidEndpointScheme('  https://api.openai.com/v1  ')).toBe(true)
})

test('rejects javascript: and file: endpoint schemes', () => {
  expect(hasValidEndpointScheme('javascript:alert(1)')).toBe(false)
  expect(hasValidEndpointScheme('file:///etc/passwd')).toBe(false)
})

test('rejects garbage and a bare host:port typo missing its leading //', () => {
  expect(hasValidEndpointScheme('not a url')).toBe(false)
  // A very real typo: "localhost:11434/v1" parses as scheme "localhost:", not http.
  expect(hasValidEndpointScheme('localhost:11434/v1')).toBe(false)
})
