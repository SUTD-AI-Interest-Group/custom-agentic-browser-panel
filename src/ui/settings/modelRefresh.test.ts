import { describe, expect, test } from 'vitest'
import type { FetchedModel } from '../../platform/modelList'
import type { ProviderConfig } from '../../data/settings'
import { mergeFetchedModels, resolveModelRefresh } from './modelRefresh'

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'p1',
    name: 'Test',
    baseURL: 'https://api.example.com/v1',
    apiKey: '',
    models: [],
    ...overrides,
  }
}

const noHeuristicMatch = () => false
const alwaysHeuristicMatch = () => true

describe('mergeFetchedModels', () => {
  test('sorts ids case-insensitively', () => {
    const { models } = mergeFetchedModels(undefined, [{ id: 'gpt-4o' }, { id: 'Claude-3' }, { id: 'ada' }], noHeuristicMatch)
    expect(models).toEqual(['ada', 'Claude-3', 'gpt-4o'])
  })

  test('seeds a manual reasoning flag only when the API says true AND the heuristic disagrees', () => {
    const fetched: FetchedModel[] = [
      { id: 'model-a', reasoning: true }, // API says reasoning, heuristic would miss it
      { id: 'model-b', reasoning: true }, // API says reasoning, heuristic already gets it right
      { id: 'model-c', reasoning: false }, // API explicitly says no
      { id: 'model-d' }, // API silent
    ]
    const { modelConfigs } = mergeFetchedModels(
      undefined,
      fetched,
      (id) => id === 'model-b', // heuristic only recognizes model-b
    )
    expect(modelConfigs['model-a']).toEqual({ reasoning: true })
    // model-b: heuristic already agrees, so no redundant manual override is stamped.
    expect(modelConfigs['model-b']).toBeUndefined()
    expect(modelConfigs['model-c']).toBeUndefined()
    expect(modelConfigs['model-d']).toBeUndefined()
  })

  test('never stomps a heuristic that already got it right', () => {
    const { modelConfigs } = mergeFetchedModels(undefined, [{ id: 'x', reasoning: true }], alwaysHeuristicMatch)
    expect(modelConfigs['x']).toBeUndefined()
  })

  test('preserves unrelated existing modelConfigs entries — a manual reasoningEffort override survives a refresh', () => {
    const existing = { 'model-a': { reasoningEffort: 'high' as const } }
    const { modelConfigs } = mergeFetchedModels(existing, [{ id: 'model-a' }], noHeuristicMatch)
    expect(modelConfigs['model-a']).toEqual({ reasoningEffort: 'high' })
  })

  test('a reasoning-flag seed merges into (not replaces) an existing per-model config', () => {
    const existing = { 'model-a': { reasoningEffort: 'high' as const } }
    const { modelConfigs } = mergeFetchedModels(existing, [{ id: 'model-a', reasoning: true }], noHeuristicMatch)
    expect(modelConfigs['model-a']).toEqual({ reasoningEffort: 'high', reasoning: true })
  })
})

describe('resolveModelRefresh', () => {
  test('applies the fetch and returns the updated provider list when nothing else changed', () => {
    const providers = [provider({ id: 'p1', models: [] })]
    const result = resolveModelRefresh('p1', providers, providers, [{ id: 'gpt-4o-mini' }], noHeuristicMatch)
    expect(result.stale).toBe(false)
    expect(result.providers.find((p) => p.id === 'p1')?.models).toEqual(['gpt-4o-mini'])
    expect(result.message).toMatch(/Loaded 1 model/)
  })

  // Regression test for the HIGH finding: a slow "Refresh from endpoint" call
  // must never silently revert a concurrent edit (another provider added, a
  // field blurred elsewhere) that landed while the fetch was in flight.
  test('a concurrent commit while the fetch was in flight is never silently reverted', () => {
    const baseline = [provider({ id: 'p1', models: [] })]
    // Simulates Settings.tsx committing a change elsewhere: a NEW providers
    // array reference (every commit rebuilds `providers`), here with a second
    // provider added while the fetch for p1 was outstanding.
    const current = [...baseline, provider({ id: 'p2', name: 'Added mid-flight' })]
    const result = resolveModelRefresh('p1', baseline, current, [{ id: 'gpt-4o-mini' }], noHeuristicMatch)
    expect(result.stale).toBe(true)
    // The concurrently-added provider must survive untouched.
    expect(result.providers).toBe(current)
    expect(result.providers.some((p) => p.id === 'p2')).toBe(true)
    expect(result.message).toMatch(/try again/i)
  })

  test('only the targeted provider is updated; siblings are untouched', () => {
    const providers = [provider({ id: 'p1', models: [] }), provider({ id: 'p2', name: 'Other', models: ['keep-me'] })]
    const result = resolveModelRefresh('p1', providers, providers, [{ id: 'new-model' }], noHeuristicMatch)
    expect(result.providers.find((p) => p.id === 'p2')?.models).toEqual(['keep-me'])
  })
})
