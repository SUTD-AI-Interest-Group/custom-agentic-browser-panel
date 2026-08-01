import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetVault } from './vault'
import { isSealed } from './vaultFormat'
import { defaultSettings, loadSettings, saveSettings, type Settings } from './settings'

// Minimal chrome.storage.local stub backed by a plain object — the repo's
// established per-file pattern (see src/ui/tabChats.test.ts).
function stubChromeStorage(): Record<string, unknown> {
  const store: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items)
        }),
      },
    },
  })
  return store
}

function withKey(): Settings {
  const s = defaultSettings()
  s.providers = [{ id: 'p1', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKey: 'sk-live-1', models: [] }]
  s.onboarded = true
  return s
}

beforeEach(async () => {
  await resetVault()
})

describe('settings storage sealing', () => {
  it('saveSettings writes sealed keys and does not mutate its input', async () => {
    const store = stubChromeStorage()
    const settings = withKey()
    await saveSettings(settings)
    const stored = store.settings as Settings
    expect(isSealed(stored.providers[0].apiKey)).toBe(true)
    expect(settings.providers[0].apiKey).toBe('sk-live-1')
  })

  it('loadSettings returns decrypted keys', async () => {
    stubChromeStorage()
    await saveSettings(withKey())
    const loaded = await loadSettings()
    expect(loaded.providers[0].apiKey).toBe('sk-live-1')
  })

  it('migrates a plaintext install in place (sealed at rest after first load)', async () => {
    const store = stubChromeStorage()
    store.settings = withKey() // simulates a pre-vault install
    const loaded = await loadSettings()
    expect(loaded.providers[0].apiKey).toBe('sk-live-1')
    const migrated = store.settings as Settings
    expect(isSealed(migrated.providers[0].apiKey)).toBe(true)
  })

  it('does not clobber a concurrent save that lands mid-migration', async () => {
    const store: Record<string, unknown> = { settings: withKey() } // simulates a pre-vault install
    const concurrentlySaved: Settings = { ...withKey(), providers: [{ ...withKey().providers[0], apiKey: 'sk-live-2' }] }
    let getCalls = 0
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => {
            getCalls++
            const result = key in store ? { [key]: store[key] } : {}
            // After the load's own read (the first get), simulate a real
            // saveSettings landing before the migration's re-read guard runs.
            if (getCalls === 1) store.settings = concurrentlySaved
            return result
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(store, items)
          }),
        },
      },
    })
    const loaded = await loadSettings()
    expect(loaded.providers[0].apiKey).toBe('sk-live-1') // reflects the pre-race snapshot
    expect(store.settings).toBe(concurrentlySaved) // migration skipped its write — nothing clobbered
  })

  it('falls back to plaintext storage when IndexedDB is unavailable', async () => {
    const store = stubChromeStorage()
    const { _resetDekCacheForTests } = await import('./vault')
    const original = globalThis.indexedDB
    vi.stubGlobal('indexedDB', undefined)
    _resetDekCacheForTests()
    try {
      await saveSettings(withKey())
      const stored = store.settings as Settings
      expect(stored.providers[0].apiKey).toBe('sk-live-1')
      const loaded = await loadSettings()
      expect(loaded.providers[0].apiKey).toBe('sk-live-1')
    } finally {
      vi.stubGlobal('indexedDB', original)
      _resetDekCacheForTests()
    }
  })

  it('preserves ciphertext (never blanks to \'\') when the vault is transiently down for an already-sealed install, and warns once', async () => {
    const store = stubChromeStorage()
    const { _resetDekCacheForTests } = await import('./vault')

    // Save with a real key while the vault works: sealed at rest.
    await saveSettings(withKey())
    const sealedApiKey = (store.settings as Settings).providers[0].apiKey
    expect(isSealed(sealedApiKey)).toBe(true)

    // Simulate a transient vault outage.
    const original = globalThis.indexedDB
    vi.stubGlobal('indexedDB', undefined)
    _resetDekCacheForTests()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let loaded: Settings
    try {
      loaded = await loadSettings()
      // Not silently blanked to '' — still the original sealed ciphertext.
      expect(loaded.providers[0].apiKey).not.toBe('')
      expect(isSealed(loaded.providers[0].apiKey)).toBe(true)
      expect(loaded.providers[0].apiKey).toBe(sealedApiKey)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[vault] some secrets could not be decrypted this load'))
    } finally {
      warnSpy.mockRestore()
      vi.stubGlobal('indexedDB', original)
      _resetDekCacheForTests()
    }

    // Load-bearing: saving the still-sealed settings during the outage must
    // not destroy the ciphertext. sealSecret's isSealed short-circuit makes
    // this re-save a no-op, so the original plaintext survives.
    await saveSettings(loaded)
    const roundTripped = await loadSettings()
    expect(roundTripped.providers[0].apiKey).toBe('sk-live-1')
  })
})
