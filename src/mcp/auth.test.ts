import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { _resetDekCacheForTests, resetVault } from '../data/vault'
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

/** Simulate a transient vault outage for the duration of `fn`, then restore. */
async function withVaultDown(fn: () => Promise<void>): Promise<void> {
  const original = globalThis.indexedDB
  vi.stubGlobal('indexedDB', undefined)
  _resetDekCacheForTests()
  try {
    await fn()
  } finally {
    vi.stubGlobal('indexedDB', original)
    _resetDekCacheForTests()
  }
}

/** Stub chrome.identity + chrome.runtime alongside storage, for redirectToAuthorization tests. */
function stubChromeIdentity(
  onLaunch: (details: { url: string; interactive: boolean }, callback: (redirect?: string) => void) => void,
): { launch: ReturnType<typeof vi.fn>; store: Record<string, unknown> } {
  const store: Record<string, unknown> = {}
  const launch = vi.fn(onLaunch)
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
    runtime: {},
    identity: { launchWebAuthFlow: launch },
  })
  return { launch, store }
}

const TOKENS = { access_token: 'at-1', token_type: 'Bearer', refresh_token: 'rt-1' }
const CLIENT_INFO = { client_id: 'test-client-id', client_secret: 'test-client-secret' }

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

describe('vault outage hardening', () => {
  it('a save during a vault outage must not destroy previously-sealed tokens/clientInformation', async () => {
    const store = stubChromeStorage()
    const provider = new ChromeOAuthProvider('srv')
    await provider.saveTokens(TOKENS)
    await provider.saveClientInformation(CLIENT_INFO)
    const sealedBefore = store['mcpAuth:srv']
    expect((sealedBefore as { sealed?: string }).sealed?.startsWith('lysec1.')).toBe(true)

    await withVaultDown(async () => {
      // The write must fail rather than silently narrow the persisted record
      // down to just this call's own field.
      await expect(provider.saveCodeVerifier('pkce-during-outage')).rejects.toThrow(/vault/i)
      // And the previously-sealed blob must be completely untouched.
      expect(store['mcpAuth:srv']).toEqual(sealedBefore)
    })

    // Vault recovers: everything sealed before the outage is still there.
    expect(await provider.tokens()).toEqual(TOKENS)
    expect(await provider.clientInformation()).toEqual(CLIENT_INFO)
    // The outage-time write never landed — restart the flow from scratch.
    await expect(provider.codeVerifier()).rejects.toThrow('No PKCE verifier saved')
  })

  it('invalidateCredentials(one scope) during an outage must not wipe the other scopes', async () => {
    const store = stubChromeStorage()
    const provider = new ChromeOAuthProvider('srv')
    await provider.saveTokens(TOKENS)
    await provider.saveClientInformation(CLIENT_INFO)
    await provider.saveCodeVerifier('pkce-1')
    const sealedBefore = store['mcpAuth:srv']

    await withVaultDown(async () => {
      await expect(provider.invalidateCredentials('tokens')).rejects.toThrow(/vault/i)
      expect(store['mcpAuth:srv']).toEqual(sealedBefore)
    })

    // Nothing was wiped — including the "tokens" scope the call targeted.
    expect(await provider.tokens()).toEqual(TOKENS)
    expect(await provider.clientInformation()).toEqual(CLIENT_INFO)
    expect(await provider.codeVerifier()).toBe('pkce-1')
  })

  it("invalidateCredentials('all') still wipes everything during an outage — an explicit full erase has nothing to protect", async () => {
    const store = stubChromeStorage()
    const provider = new ChromeOAuthProvider('srv')
    await provider.saveTokens(TOKENS)

    await withVaultDown(async () => {
      await provider.invalidateCredentials('all')
      expect(store['mcpAuth:srv']).toBeUndefined()
    })

    expect(await hasStoredAuth('srv')).toBe(false)
  })

  it('a save while nothing was ever stored succeeds even with the vault down (nothing to lose)', async () => {
    stubChromeStorage()
    const provider = new ChromeOAuthProvider('srv')
    await withVaultDown(async () => {
      await provider.saveCodeVerifier('pkce-fresh')
    })
    expect(await provider.codeVerifier()).toBe('pkce-fresh')
  })
})

describe('redirectToAuthorization', () => {
  it('a non-interactive provider refuses without ever touching chrome.identity', async () => {
    const { launch } = stubChromeIdentity(() => {
      throw new Error('must not be called')
    })
    const provider = new ChromeOAuthProvider('srv') // opts.interactive left unset
    await expect(provider.redirectToAuthorization(new URL('https://example.com/authorize'))).rejects.toThrow(
      UnauthorizedError,
    )
    expect(launch).not.toHaveBeenCalled()
  })

  it('an interactive provider launches the web auth flow and captures the code once', async () => {
    const provider = new ChromeOAuthProvider('srv', { interactive: true })
    const expectedState = provider.state()
    stubChromeIdentity((details, callback) => {
      expect(details.url).toBe('https://example.com/authorize')
      expect(details.interactive).toBe(true)
      callback(`https://abc123.chromiumapp.org/mcp?code=test-code-1&state=${expectedState}`)
    })
    await provider.redirectToAuthorization(new URL('https://example.com/authorize'))
    expect(provider.takeAuthorizationCode()).toBe('test-code-1')
    expect(provider.takeAuthorizationCode()).toBeUndefined() // consumed once
  })

  it('a state mismatch is rejected', async () => {
    const provider = new ChromeOAuthProvider('srv', { interactive: true })
    provider.state()
    stubChromeIdentity((_details, callback) => {
      callback('https://abc123.chromiumapp.org/mcp?code=test-code-1&state=not-the-expected-state')
    })
    await expect(provider.redirectToAuthorization(new URL('https://example.com/authorize'))).rejects.toThrow(
      'state mismatch',
    )
  })

  it('a redirect with no code is rejected', async () => {
    const provider = new ChromeOAuthProvider('srv', { interactive: true })
    stubChromeIdentity((_details, callback) => {
      callback('https://abc123.chromiumapp.org/mcp?state=xyz')
    })
    await expect(provider.redirectToAuthorization(new URL('https://example.com/authorize'))).rejects.toThrow(
      'carried no code',
    )
  })

  it("a redirect carrying the server's error param is rejected", async () => {
    const provider = new ChromeOAuthProvider('srv', { interactive: true })
    stubChromeIdentity((_details, callback) => {
      callback('https://abc123.chromiumapp.org/mcp?error=access_denied&error_description=User%20said%20no')
    })
    await expect(provider.redirectToAuthorization(new URL('https://example.com/authorize'))).rejects.toThrow(
      'User said no',
    )
  })
})
