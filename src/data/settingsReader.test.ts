import { beforeEach, describe, expect, it, vi } from 'vitest'

// The vault is what makes a load expensive (one AES-GCM decrypt per secret); count its calls.
const vault = vi.hoisted(() => ({ unavailable: false, opens: 0 }))
vi.mock('./settingsVault', () => ({
  openSettings: async (settings: unknown) => {
    vault.opens++
    return { settings, hadPlaintext: false, hadUnavailable: vault.unavailable }
  },
  sealSettings: async (settings: unknown) => settings,
}))
vi.mock('../mcp/auth', () => ({ clearAuth: vi.fn(async () => {}) }))

import { createSettingsReader } from './settings'

let stored: Record<string, unknown>
beforeEach(() => {
  vault.opens = 0
  vault.unavailable = false
  stored = {
    settings: {
      providers: [{ id: 'p', kind: 'custom', name: 'P', baseURL: 'http://x/v1', apiKey: 'lysec1.sealed', models: ['m'] }],
      selected: { providerId: 'p', modelId: 'm' },
      systemPrompt: 'Answer.', tabAccess: 'active-tab', onboarded: true,
      toolPolicies: { ControlPage: 'ask' },
    },
  }
  vi.stubGlobal('chrome', { storage: { local: {
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(stored[key]) })),
    set: vi.fn(async () => {}),
  } } })
})

describe('createSettingsReader', () => {
  it('opens the vault once while the stored settings are unchanged', async () => {
    const read = createSettingsReader()
    await read(); await read(); await read()
    expect(vault.opens).toBe(1)
  })

  it('sees an edit on the very next call — a policy change is never served stale', async () => {
    const read = createSettingsReader()
    expect((await read()).toolPolicies?.ControlPage).toBe('ask')
    ;(stored.settings as { toolPolicies: Record<string, string> }).toolPolicies.ControlPage = 'never'
    expect((await read()).toolPolicies?.ControlPage).toBe('never')
    expect(vault.opens).toBe(2)
  })

  it('hands out copies, so a caller mutating its result cannot corrupt the next one', async () => {
    const read = createSettingsReader()
    const first = await read()
    first.providers.length = 0
    expect((await read()).providers).toHaveLength(1)
  })

  it('never reuses a load made during a vault outage', async () => {
    vault.unavailable = true
    const read = createSettingsReader()
    await read(); await read()
    expect(vault.opens).toBe(2)
  })
})
