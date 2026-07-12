import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SYSTEM_PROMPT,
  defaultSettings,
  groupPolicy,
  resetSettingsKeepingProviders,
  setGroupPolicy,
  toolPolicy,
  type Settings,
} from './settings'

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
    // 'reading' holds ReadPage, ReadTabs, ExtractData, StartResearch — all default 'ask'.
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
    expect(toolPolicy(next, 'StartResearch')).toBe('never')
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
})

describe('defaultSettings', () => {
  it('is a fresh, un-onboarded, provider-less config', () => {
    const d = defaultSettings()
    expect(d.onboarded).toBe(false)
    expect(d.providers).toEqual([])
    expect(d.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT)
  })
})
