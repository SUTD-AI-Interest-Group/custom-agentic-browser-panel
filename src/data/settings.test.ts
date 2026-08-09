import { describe, expect, it, test, vi } from 'vitest'
import {
  DEFAULT_DREAM_INTERVAL_MS,
  DEFAULT_SYSTEM_PROMPT,
  defaultSettings,
  getDreamProvider,
  groupPolicy,
  inferKind,
  migrateResearchToolPolicy,
  resetSettingsKeepingProviders,
  resolveDreamIntervalMs,
  resolveReasoningEffort,
  setGroupPolicy,
  toolPolicy,
  type ProviderConfig,
  type Settings,
} from './settings'

// resetSettingsKeepingProviders drops Settings.mcp entirely; F5 (d07) is that
// the per-server OAuth tokens each server accumulates live in a SEPARATE
// mcpAuth:<server> sidecar key (src/mcp/auth.ts) this reset never touches —
// mocked here (rather than exercised against a real chrome.storage.local)
// since ../mcp/auth is outside this file's ownership and this test only needs
// to confirm the cleanup call happens, not auth.ts's own storage behavior.
vi.mock('../mcp/auth', () => ({ clearAuth: vi.fn(async () => {}) }))

function base(overrides: Partial<Settings> = {}): Settings {
  return {
    providers: [],
    selected: null,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    tabAccess: 'active-tab',
    onboarded: true,
    ...overrides,
  }
}

describe('groupPolicy', () => {
  it('returns the shared policy when every tool in the group agrees', () => {
    // 'reading' holds ReadPage, ReadTabs, ExtractData, ProposeResearch — all default 'ask'.
    expect(groupPolicy(base(), 'reading')).toBe('ask')
  })

  it("returns 'mixed' when the group's tools disagree", () => {
    const s = base({ toolPolicies: { ReadPage: 'always' } })
    expect(groupPolicy(s, 'reading')).toBe('mixed')
  })

  it('reflects catalog defaults, not just explicit overrides', () => {
    // ListAllSkills + ReadSkill default to 'always', SaveSkill to 'ask'.
    expect(groupPolicy(base(), 'skills')).toBe('mixed')
  })

  it('returns the shared policy when overrides make a mixed group uniform', () => {
    const s = base({ toolPolicies: { SaveSkill: 'always' } })
    expect(groupPolicy(s, 'skills')).toBe('always')
  })
})

describe('setGroupPolicy', () => {
  it('sets every tool in the group and leaves other groups alone', () => {
    const next = setGroupPolicy(base(), 'reading', 'never')
    expect(toolPolicy(next, 'ReadPage')).toBe('never')
    expect(toolPolicy(next, 'ReadTabs')).toBe('never')
    expect(toolPolicy(next, 'ExtractData')).toBe('never')
    expect(toolPolicy(next, 'ProposeResearch')).toBe('never')
    expect(toolPolicy(next, 'NavigateTab')).toBe('ask')
    expect(groupPolicy(next, 'reading')).toBe('never')
  })

  it('does not mutate the input', () => {
    const s = base()
    setGroupPolicy(s, 'reading', 'never')
    expect(s.toolPolicies).toBeUndefined()
  })
})

describe('resetSettingsKeepingProviders', () => {
  const configured = base({
    providers: [{ id: 'p1', name: 'OpenAI', baseURL: 'u', apiKey: 'sk-secret', models: ['m'] }],
    selected: { providerId: 'p1', modelId: 'm' },
    systemPrompt: 'my custom prompt',
    tabAccess: 'all-tabs',
    toolPolicies: { ReadPage: 'always' },
  })

  it('keeps providers, keys and the selected model', () => {
    const next = resetSettingsKeepingProviders(configured)
    expect(next.providers).toEqual(configured.providers)
    expect(next.selected).toEqual({ providerId: 'p1', modelId: 'm' })
  })

  it('restores prompt, tab access and tool policies to defaults', () => {
    const next = resetSettingsKeepingProviders(configured)
    expect(next.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT)
    expect(next.tabAccess).toBe('active-tab')
    expect(toolPolicy(next, 'ReadPage')).toBe('ask')
  })

  it('stays onboarded so the user is not thrown back into the wizard', () => {
    expect(resetSettingsKeepingProviders(configured).onboarded).toBe(true)
  })

  it('does not alias the input providers array', () => {
    const next = resetSettingsKeepingProviders(configured)
    next.providers[0].apiKey = 'changed'
    expect(configured.providers[0].apiKey).toBe('sk-secret')
  })

  it('drops the MCP server list', () => {
    // Documents current behavior precisely (d13 F4's chosen fix is correcting
    // the UI copy, not changing this) — mcp is not among what "Reset settings"
    // preserves.
    const withMcp = base({ ...configured, mcp: { servers: { s1: { command: 'x' } } } })
    expect(resetSettingsKeepingProviders(withMcp).mcp).toBeUndefined()
  })

  it('clears each dropped MCP server\'s orphaned OAuth sidecar entry (F5)', async () => {
    const { clearAuth } = await import('../mcp/auth')
    vi.mocked(clearAuth).mockClear()
    const withMcp = base({
      ...configured,
      mcp: { servers: { s1: { command: 'x' }, s2: { url: 'https://example.com' } } },
    })
    resetSettingsKeepingProviders(withMcp)
    // mcpAuth:<server> lives outside Settings entirely (src/mcp/auth.ts) — the
    // reset must not silently orphan it just because settings.mcp itself is
    // dropped above.
    expect(clearAuth).toHaveBeenCalledWith('s1')
    expect(clearAuth).toHaveBeenCalledWith('s2')
  })

  it('does not touch mcpAuth when there were no configured servers', async () => {
    const { clearAuth } = await import('../mcp/auth')
    vi.mocked(clearAuth).mockClear()
    resetSettingsKeepingProviders(configured)
    expect(clearAuth).not.toHaveBeenCalled()
  })
})

describe('defaultSettings', () => {
  it('is a fresh, un-onboarded, provider-less config', () => {
    const d = defaultSettings()
    expect(d.onboarded).toBe(false)
    expect(d.providers).toEqual([])
    expect(d.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT)
  })
})

const provider = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'p',
  name: 'P',
  baseURL: '',
  apiKey: '',
  models: [],
  ...overrides,
})

describe('inferKind', () => {
  it('maps known hosts to their kind', () => {
    expect(inferKind('https://api.openai.com/v1')).toBe('openai')
    expect(inferKind('https://api.anthropic.com/v1')).toBe('anthropic')
    expect(inferKind('https://openrouter.ai/api/v1')).toBe('openrouter')
    expect(inferKind('https://api.groq.com/openai/v1')).toBe('groq')
    expect(inferKind('http://localhost:11434/v1')).toBe('ollama')
    expect(inferKind('http://localhost:1234/v1')).toBe('lmstudio')
  })

  it('falls back to custom for an unrecognised endpoint', () => {
    expect(inferKind('https://my-proxy.example.com/v1')).toBe('custom')
  })
})

describe('resolveReasoningEffort', () => {
  it('prefers the per-model override over the provider default', () => {
    const p = provider({ reasoningEffort: 'low', modelConfigs: { m1: { reasoningEffort: 'high' } } })
    expect(resolveReasoningEffort(p, 'm1')).toBe('high')
  })

  it('falls back to the provider default for a model with no override', () => {
    const p = provider({ reasoningEffort: 'low', modelConfigs: { m1: { reasoningEffort: 'high' } } })
    expect(resolveReasoningEffort(p, 'm2')).toBe('low')
  })

  it('is undefined when neither model nor provider set it', () => {
    expect(resolveReasoningEffort(provider(), 'm1')).toBeUndefined()
  })
})

describe('resolveDreamIntervalMs', () => {
  it('falls back to the 24h default when unset', () => {
    expect(resolveDreamIntervalMs(base())).toBe(DEFAULT_DREAM_INTERVAL_MS)
  })

  it('uses a positive stored interval', () => {
    expect(resolveDreamIntervalMs(base({ dreamIntervalMs: 30 * 60 * 1000 }))).toBe(30 * 60 * 1000)
  })

  it('ignores a non-positive interval and defaults', () => {
    expect(resolveDreamIntervalMs(base({ dreamIntervalMs: 0 }))).toBe(DEFAULT_DREAM_INTERVAL_MS)
  })
})

describe('getDreamProvider', () => {
  const p1 = provider({ id: 'p1', name: 'Chat', models: ['chat-model'] })
  const p2 = provider({ id: 'p2', name: 'Cheap', models: ['tiny-model'] })
  const configured = base({ providers: [p1, p2], selected: { providerId: 'p1', modelId: 'chat-model' } })

  it('falls back to the chat model when dreamModel is unset', () => {
    expect(getDreamProvider(configured)).toEqual({ provider: p1, modelId: 'chat-model' })
  })

  it('uses the dreamModel when set and its provider still exists', () => {
    const s = base({ ...configured, dreamModel: { providerId: 'p2', modelId: 'tiny-model' } })
    expect(getDreamProvider(s)).toEqual({ provider: p2, modelId: 'tiny-model' })
  })

  it('falls back to the chat model when the dreamModel provider is gone', () => {
    const s = base({ ...configured, dreamModel: { providerId: 'deleted', modelId: 'x' } })
    expect(getDreamProvider(s)).toEqual({ provider: p1, modelId: 'chat-model' })
  })

  it('is null when nothing is configured', () => {
    expect(getDreamProvider(base())).toBeNull()
  })
})

test('carries a StartResearch policy over to ProposeResearch', () => {
  const out = migrateResearchToolPolicy({ StartResearch: 'never', ReadPage: 'always' })
  expect(out).toEqual({ ProposeResearch: 'never', ReadPage: 'always' })
})

test('an existing ProposeResearch policy wins over the legacy key', () => {
  const out = migrateResearchToolPolicy({ StartResearch: 'never', ProposeResearch: 'ask' })
  expect(out).toEqual({ ProposeResearch: 'ask' })
})

test('is a no-op when the legacy key is absent', () => {
  expect(migrateResearchToolPolicy({ ReadPage: 'ask' })).toEqual({ ReadPage: 'ask' })
  expect(migrateResearchToolPolicy(undefined)).toBeUndefined()
})
