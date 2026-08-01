import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetVault } from './vault'
import { isSealed } from './vaultFormat'
import { openSettings, sealSettings, secretValues } from './settingsVault'
import { defaultSettings, type Settings } from './settings'

beforeEach(async () => {
  await resetVault()
})

function sampleSettings(): Settings {
  return {
    ...defaultSettings(),
    providers: [
      { id: 'p1', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKey: 'sk-one', models: [] },
      { id: 'p2', name: 'Local', baseURL: 'http://localhost:11434/v1', apiKey: '', models: [] },
    ],
    observability: {
      enabled: true,
      publicKey: 'pk-lf-x',
      secretKey: 'sk-lf-y',
      host: 'https://cloud.langfuse.com',
      captureContent: true,
      captureScreenshots: false,
    },
    mcp: {
      servers: {
        ctx: { url: 'https://mcp.example.com', headers: { Authorization: 'Bearer tok-123' } },
        bare: { url: 'https://bare.example.com' },
      },
    },
  }
}

describe('settingsVault', () => {
  it('secretValues enumerates exactly the four surfaces', () => {
    expect(secretValues(sampleSettings())).toEqual(['sk-one', '', 'pk-lf-x', 'sk-lf-y', 'Bearer tok-123'])
  })

  it('seals every non-empty secret and nothing else', async () => {
    const input = sampleSettings()
    const sealed = await sealSettings(input)
    expect(isSealed(sealed.providers[0].apiKey)).toBe(true)
    expect(sealed.providers[1].apiKey).toBe('')
    expect(isSealed(sealed.observability!.publicKey)).toBe(true)
    expect(isSealed(sealed.observability!.secretKey)).toBe(true)
    expect(isSealed(sealed.mcp!.servers.ctx.headers!.Authorization)).toBe(true)
    // Non-secrets untouched
    expect(sealed.providers[0].baseURL).toBe('https://api.openai.com/v1')
    expect(sealed.observability!.host).toBe('https://cloud.langfuse.com')
    expect(sealed.mcp!.servers.bare).toEqual({ url: 'https://bare.example.com' })
    // Input never mutated
    expect(input.providers[0].apiKey).toBe('sk-one')
    expect(input.mcp!.servers.ctx.headers!.Authorization).toBe('Bearer tok-123')
  })

  it('openSettings round-trips and reports plaintext presence', async () => {
    const sealed = await sealSettings(sampleSettings())
    const fromSealed = await openSettings(sealed)
    expect(fromSealed.hadPlaintext).toBe(false)
    expect(fromSealed.hadUnavailable).toBe(false)
    expect(fromSealed.settings.providers[0].apiKey).toBe('sk-one')
    expect(fromSealed.settings.mcp!.servers.ctx.headers!.Authorization).toBe('Bearer tok-123')
    const fromPlain = await openSettings(sampleSettings())
    expect(fromPlain.hadPlaintext).toBe(true)
    expect(fromPlain.hadUnavailable).toBe(false)
    expect(fromPlain.settings.providers[0].apiKey).toBe('sk-one')
  })

  it('handles settings with no observability and no mcp', async () => {
    const bare = defaultSettings()
    bare.observability = undefined
    const sealed = await sealSettings(bare)
    const opened = await openSettings(sealed)
    expect(opened.hadPlaintext).toBe(false)
    expect(opened.hadUnavailable).toBe(false)
  })

  it('passes sealed values through verbatim and reports hadUnavailable when the vault is down', async () => {
    const sealed = await sealSettings(sampleSettings())
    const { _resetDekCacheForTests } = await import('./vault')
    const original = globalThis.indexedDB
    vi.stubGlobal('indexedDB', undefined)
    _resetDekCacheForTests()
    try {
      const opened = await openSettings(sealed)
      expect(opened.hadUnavailable).toBe(true)
      // Not blanked to '' — still the original sealed ciphertext, recoverable later.
      expect(opened.settings.providers[0].apiKey).toBe(sealed.providers[0].apiKey)
      expect(isSealed(opened.settings.providers[0].apiKey)).toBe(true)
    } finally {
      vi.stubGlobal('indexedDB', original)
      _resetDekCacheForTests()
    }
  })
})
