import { describe, expect, it } from 'vitest'
import { isReasoningModel, profileFor, reasoningLevelsFor } from './providerProfiles'
import type { ProviderConfig } from './settings'

const provider = (o: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'p',
  name: 'P',
  baseURL: '',
  apiKey: '',
  models: [],
  ...o,
})

describe('adapter selection', () => {
  it('routes openai/anthropic to native adapters, the rest to compatible', () => {
    expect(profileFor('openai').adapter).toBe('openai')
    expect(profileFor('anthropic').adapter).toBe('anthropic')
    for (const k of ['openrouter', 'groq', 'ollama', 'lmstudio', 'custom'] as const) {
      expect(profileFor(k).adapter).toBe('compatible')
    }
  })
})

describe('openai profile', () => {
  const p = profileFor('openai')
  it('detects o-series, gpt-5, gpt-oss — but not gpt-4o', () => {
    expect(p.detectReasoning('o3-mini')).toBe(true)
    expect(p.detectReasoning('o1')).toBe(true)
    expect(p.detectReasoning('gpt-5.6-luna')).toBe(true)
    expect(p.detectReasoning('gpt-oss-120b')).toBe(true)
    expect(p.detectReasoning('gpt-4o')).toBe(false)
    expect(p.detectReasoning('gpt-4o-mini')).toBe(false)
  })
  it('offers wider rungs for gpt-5.6, none-less for o-series', () => {
    expect(p.reasoningLevels('gpt-5.6-luna')).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(p.reasoningLevels('gpt-5.1')).toEqual(['none', 'low', 'medium', 'high'])
    expect(p.reasoningLevels('o3')).toEqual(['low', 'medium', 'high'])
  })
  it('injects reasoningEffort via provider options, nothing when unset', () => {
    expect(p.reasoningOptions!('high')).toEqual({ reasoningEffort: 'high' })
    expect(p.reasoningOptions!(undefined)).toEqual({})
  })
})

describe('anthropic profile', () => {
  const p = profileFor('anthropic')
  it('treats Claude models as reasoning-capable', () => {
    expect(p.detectReasoning('claude-opus-4-8')).toBe(true)
    expect(p.detectReasoning('claude-sonnet-5')).toBe(true)
  })
  it('maps none → disabled, anything else → adaptive summarized', () => {
    expect(p.reasoningOptions!('none')).toEqual({ thinking: { type: 'disabled' } })
    expect(p.reasoningOptions!('high')).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } })
    expect(p.reasoningOptions!(undefined)).toEqual({})
  })
})

describe('openrouter profile', () => {
  const p = profileFor('openrouter')
  it('uses the unified reasoning object, never a bare reasoning_effort', () => {
    expect(p.reasoningBody!('high', true)).toEqual({ reasoning: { effort: 'high' } })
    expect(p.reasoningBody!('none', true)).toEqual({ reasoning: { enabled: false } })
    expect(p.reasoningBody!(undefined, true)).toEqual({})
    // guard the incompatibility the research flagged: no top-level reasoning_effort ever
    expect(p.reasoningBody!('high', true)).not.toHaveProperty('reasoning_effort')
  })
})

describe('groq profile', () => {
  const p = profileFor('groq')
  it('forces reasoning_format:parsed whenever tools are present (raw + tools = 400)', () => {
    expect(p.reasoningBody!('high', true)).toEqual({ reasoning_effort: 'high', reasoning_format: 'parsed' })
    // even with no effort set, a detected reasoning model + tools still needs parsed
    expect(p.reasoningBody!(undefined, true)).toEqual({ reasoning_format: 'parsed' })
    expect(p.reasoningBody!('none', true)).toEqual({ reasoning_format: 'parsed' })
  })
  it('omits reasoning_format without tools', () => {
    expect(p.reasoningBody!('medium', false)).toEqual({ reasoning_effort: 'medium' })
    expect(p.reasoningBody!(undefined, false)).toEqual({})
  })
  it('detects deepseek-r1 / qwen3 / gpt-oss', () => {
    expect(p.detectReasoning('deepseek-r1-distill-llama-70b')).toBe(true)
    expect(p.detectReasoning('qwen3-32b')).toBe(true)
    expect(p.detectReasoning('llama-3.1-8b-instant')).toBe(false)
  })
})

describe('ollama / lmstudio / custom compat body', () => {
  it('passes a set reasoning_effort straight through, nothing when unset', () => {
    for (const k of ['ollama', 'lmstudio', 'custom'] as const) {
      const p = profileFor(k)
      expect(p.reasoningBody!('low', true)).toEqual({ reasoning_effort: 'low' })
      expect(p.reasoningBody!(undefined, true)).toEqual({})
    }
  })
})

describe('models endpoints', () => {
  it('builds the right URL and auth per kind', () => {
    expect(profileFor('openai').modelsEndpoint!.url('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/models',
    )
    expect(profileFor('openai').modelsEndpoint!.auth).toBe('bearer')
    expect(profileFor('anthropic').modelsEndpoint!.auth).toBe('anthropic')
    expect(profileFor('openrouter').modelsEndpoint!.url('ignored')).toBe(
      'https://openrouter.ai/api/v1/models',
    )
    expect(profileFor('openrouter').modelsEndpoint!.auth).toBe('none')
    // LM Studio's native list lives outside the /v1 base
    expect(profileFor('lmstudio').modelsEndpoint!.url('http://localhost:1234/v1')).toBe(
      'http://localhost:1234/api/v0/models',
    )
  })
})

describe('isReasoningModel / reasoningLevelsFor', () => {
  it('honors a manual override over auto-detection', () => {
    // gpt-4o is not auto-detected, but a forced-on override shows the slider
    expect(isReasoningModel(provider({ kind: 'openai', modelConfigs: { 'gpt-4o': { reasoning: true } } }), 'gpt-4o')).toBe(true)
    // a reasoning model force-hidden
    expect(isReasoningModel(provider({ kind: 'openai', modelConfigs: { 'o3': { reasoning: false } } }), 'o3')).toBe(false)
  })
  it('falls back to detection, keying kind off baseURL when unset', () => {
    expect(isReasoningModel(provider({ baseURL: 'https://api.groq.com/openai/v1' }), 'deepseek-r1-distill-qwen-32b')).toBe(true)
    expect(reasoningLevelsFor(provider({ kind: 'openai' }), 'gpt-5.6-luna')).toEqual([
      'none', 'low', 'medium', 'high', 'xhigh', 'max',
    ])
  })
})
