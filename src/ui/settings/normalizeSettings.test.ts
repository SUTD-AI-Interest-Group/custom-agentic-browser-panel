import { describe, expect, test } from 'vitest'
import type { Settings } from '../../data/settings'
import { normalizeSettings } from './normalizeSettings'

function baseSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    providers: [],
    selected: null,
    systemPrompt: 'x',
    tabAccess: 'active-tab',
    onboarded: true,
    ...overrides,
  }
}

function provider(id: string, models: string[]) {
  return { id, name: id, baseURL: 'https://api.example.com/v1', apiKey: '', models }
}

describe('normalizeSettings', () => {
  // Regression test for the LOW/MEDIUM finding: a pasted or refresh-then-typed
  // duplicate model id must not survive into a list every consumer keys off
  // by the model string (ModelPicker, the "Chat naming" select, Memory's
  // dreaming-model select all use `key={m}`-shaped keys).
  test('de-dupes a provider model list while preserving order', () => {
    const next = normalizeSettings(baseSettings({ providers: [provider('p1', ['gpt-4o', 'gpt-4o-mini', 'gpt-4o'])] }))
    expect(next.providers[0].models).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })

  test('trims whitespace and drops blank lines', () => {
    const next = normalizeSettings(baseSettings({ providers: [provider('p1', [' gpt-4o ', '', '  ', 'gpt-4o-mini'])] }))
    expect(next.providers[0].models).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })

  test('trimming that produces a duplicate is still de-duped', () => {
    const next = normalizeSettings(baseSettings({ providers: [provider('p1', ['gpt-4o', ' gpt-4o '])] }))
    expect(next.providers[0].models).toEqual(['gpt-4o'])
  })

  test('leaves a still-valid selected model untouched', () => {
    const next = normalizeSettings(
      baseSettings({
        providers: [provider('p1', ['gpt-4o'])],
        selected: { providerId: 'p1', modelId: 'gpt-4o' },
      }),
    )
    expect(next.selected).toEqual({ providerId: 'p1', modelId: 'gpt-4o' })
  })

  test('re-selects the first available provider+model when selected goes stale', () => {
    const next = normalizeSettings(
      baseSettings({
        providers: [provider('p1', []), provider('p2', ['llama3.1'])],
        selected: { providerId: 'p1', modelId: 'deleted-model' },
      }),
    )
    expect(next.selected).toEqual({ providerId: 'p2', modelId: 'llama3.1' })
  })

  test('a provider with zero valid models and no other candidate clears selected', () => {
    const next = normalizeSettings(
      baseSettings({
        providers: [provider('p1', ['', '  '])],
        selected: { providerId: 'p1', modelId: 'gpt-4o' },
      }),
    )
    expect(next.selected).toBeNull()
  })

  test('does not mutate the input', () => {
    const input = baseSettings({ providers: [provider('p1', ['gpt-4o', 'gpt-4o'])] })
    const before = JSON.stringify(input)
    normalizeSettings(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})
