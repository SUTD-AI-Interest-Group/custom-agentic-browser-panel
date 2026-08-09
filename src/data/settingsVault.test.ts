import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetVault, sealSecret } from './vault'
import { isSealed } from './vaultFormat'
import { classifySealed, openSettings, sealSettings, secretValues } from './settingsVault'
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

describe('mcp stdio env values', () => {
  // F7 (d07) graduated: stdio MCP servers commonly carry credentials in `env`
  // (e.g. GITHUB_PERSONAL_ACCESS_TOKEN), the standard pattern across Claude
  // Desktop/Cursor/VS Code MCP configs. This was a documented, deliberately-
  // deferred v1 scope exclusion
  // (docs/superpowers/specs/2026-08-01-envelope-encryption-design.md "Future
  // work"); it now rides the same seal sweep as `headers`.
  function stdioSettings(): Settings {
    return {
      ...defaultSettings(),
      mcp: {
        servers: {
          gh: {
            command: 'npx',
            args: ['gh-mcp'],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_secret123', PATH: '/usr/bin' },
          },
        },
      },
    }
  }

  it('seals every stdio env value uniformly (not just names that look sensitive)', async () => {
    const settings = stdioSettings()
    expect(secretValues(settings)).toEqual(expect.arrayContaining(['ghp_secret123', '/usr/bin']))
    const sealed = await sealSettings(settings)
    expect(isSealed(sealed.mcp!.servers.gh.env!.GITHUB_PERSONAL_ACCESS_TOKEN)).toBe(true)
    expect(isSealed(sealed.mcp!.servers.gh.env!.PATH)).toBe(true)
    // Input never mutated.
    expect(settings.mcp!.servers.gh.env!.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('ghp_secret123')
  })

  it('opens a sealed env value back to plaintext', async () => {
    const sealed = await sealSettings(stdioSettings())
    const opened = await openSettings(sealed)
    expect(opened.settings.mcp!.servers.gh.env!.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('ghp_secret123')
    expect(opened.settings.mcp!.servers.gh.env!.PATH).toBe('/usr/bin')
    expect(opened.hadPlaintext).toBe(false)
  })

  it('a legacy plaintext env value is detected as plaintext (migrates on next load)', async () => {
    const opened = await openSettings(stdioSettings())
    expect(opened.hadPlaintext).toBe(true)
    expect(opened.settings.mcp!.servers.gh.env!.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('ghp_secret123')
  })

  it('preserves a sealed env value (never blanks it) when the vault is transiently down', async () => {
    const sealed = await sealSettings(stdioSettings())
    const { _resetDekCacheForTests } = await import('./vault')
    const original = globalThis.indexedDB
    vi.stubGlobal('indexedDB', undefined)
    _resetDekCacheForTests()
    try {
      const opened = await openSettings(sealed)
      expect(opened.hadUnavailable).toBe(true)
      expect(opened.settings.mcp!.servers.gh.env!.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(
        sealed.mcp!.servers.gh.env!.GITHUB_PERSONAL_ACCESS_TOKEN,
      )
      expect(isSealed(opened.settings.mcp!.servers.gh.env!.GITHUB_PERSONAL_ACCESS_TOKEN)).toBe(true)
    } finally {
      vi.stubGlobal('indexedDB', original)
      _resetDekCacheForTests()
    }
  })

  it('serializeMcpJson (export) emits the plaintext env value, never lysec1. ciphertext', async () => {
    const { serializeMcpJson } = await import('../mcp/config')
    // The export path always reads in-memory (plaintext) settings, exactly
    // like it already does for headers — sealing applies only at rest.
    const json = serializeMcpJson(stdioSettings().mcp!.servers)
    expect(json).toContain('ghp_secret123')
    expect(json).not.toContain('lysec1.')
  })
})

describe('classifySealed', () => {
  it('classifies all-sealed, mixed, and empty value sets', async () => {
    const sealed = await sealSecret('sk-x')
    expect(classifySealed([sealed, sealed])).toBe('sealed')
    expect(classifySealed([sealed, 'sk-plain'])).toBe('unsealed')
    expect(classifySealed(['sk-plain'])).toBe('unsealed')
    expect(classifySealed(['', ''])).toBe('empty')
    expect(classifySealed([])).toBe('empty')
    expect(classifySealed([sealed, ''])).toBe('sealed')
  })
})
