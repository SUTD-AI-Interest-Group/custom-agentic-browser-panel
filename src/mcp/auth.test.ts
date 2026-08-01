import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetVault } from '../data/vault'
import { ChromeOAuthProvider, clearAuth, hasStoredAuth } from './auth'

function stubChromeStorage(): Record<string, unknown> {
  const store: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items)
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key]
        }),
      },
    },
  })
  return store
}

const TOKENS = { access_token: 'at-1', token_type: 'Bearer', refresh_token: 'rt-1' }

beforeEach(async () => {
  await resetVault()
})

describe('mcp auth sealing', () => {
  it('persists tokens sealed and reads them back', async () => {
    const store = stubChromeStorage()
    const provider = new ChromeOAuthProvider('srv')
    await provider.saveTokens(TOKENS)
    const stored = store['mcpAuth:srv'] as { v: 1; sealed: string }
    expect(stored.v).toBe(1)
    expect(stored.sealed.startsWith('lysec1.')).toBe(true)
    expect(JSON.stringify(stored)).not.toContain('at-1')
    expect(await provider.tokens()).toEqual(TOKENS)
  })

  it('reads a legacy plaintext record and reseals it on next save', async () => {
    const store = stubChromeStorage()
    store['mcpAuth:srv'] = { tokens: TOKENS }
    const provider = new ChromeOAuthProvider('srv')
    expect(await provider.tokens()).toEqual(TOKENS)
    await provider.saveCodeVerifier('pkce-1')
    const stored = store['mcpAuth:srv'] as { sealed?: string }
    expect(stored.sealed?.startsWith('lysec1.')).toBe(true)
    expect(await provider.tokens()).toEqual(TOKENS)
    expect(await provider.codeVerifier()).toBe('pkce-1')
  })

  it('hasStoredAuth understands both shapes', async () => {
    const store = stubChromeStorage()
    expect(await hasStoredAuth('srv')).toBe(false)
    store['mcpAuth:srv'] = { tokens: TOKENS }
    expect(await hasStoredAuth('srv')).toBe(true)
    const provider = new ChromeOAuthProvider('srv2')
    await provider.saveTokens(TOKENS)
    expect(await hasStoredAuth('srv2')).toBe(true)
    await clearAuth('srv2')
    expect(await hasStoredAuth('srv2')).toBe(false)
  })

  it('invalidateCredentials keeps the sealed shape', async () => {
    const store = stubChromeStorage()
    const provider = new ChromeOAuthProvider('srv')
    await provider.saveTokens(TOKENS)
    await provider.saveCodeVerifier('pkce-1')
    await provider.invalidateCredentials('tokens')
    expect(await provider.tokens()).toBeUndefined()
    expect(await provider.codeVerifier()).toBe('pkce-1')
    const stored = store['mcpAuth:srv'] as { sealed?: string }
    expect(stored.sealed?.startsWith('lysec1.')).toBe(true)
  })
})
