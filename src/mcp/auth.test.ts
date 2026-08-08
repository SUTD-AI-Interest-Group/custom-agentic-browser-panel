import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { _resetDekCacheForTests, resetVault } from '../data/vault'
import { serializeMcpJson, type McpServerEntry } from './config'
import { ChromeOAuthProvider, clearAuth, hasStoredAuth } from './auth'

const URL_A = 'https://a.example.com/mcp'
const URL_B = 'https://b.example.com/mcp'

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
    const provider = new ChromeOAuthProvider('srv', URL_A)
    await provider.saveTokens(TOKENS)
    const stored = store['mcpAuth:srv'] as { v: 1; sealed: string }
    expect(stored.v).toBe(1)
    expect(stored.sealed.startsWith('lysec1.')).toBe(true)
    expect(JSON.stringify(stored)).not.toContain('at-1')
    expect(await provider.tokens()).toEqual(TOKENS)
  })

  it('reads a legacy plaintext at-rest record and reseals it on next save', async () => {
    // "Legacy plaintext" here means the storage SHAPE predates the vault
    // (a bare object instead of `{v:1, sealed}`) — orthogonal to boundUrl
    // (content-)legacy, which is covered separately under "token scoping"
    // below. This record already carries a matching boundUrl, as it would on
    // an install that has the token-scoping fix but hit the vault-down
    // plaintext-fallback path (see persist()).
    const store = stubChromeStorage()
    store['mcpAuth:srv'] = { tokens: TOKENS, boundUrl: URL_A }
    const provider = new ChromeOAuthProvider('srv', URL_A)
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
    const provider = new ChromeOAuthProvider('srv2', URL_A)
    await provider.saveTokens(TOKENS)
    expect(await hasStoredAuth('srv2')).toBe(true)
    await clearAuth('srv2')
    expect(await hasStoredAuth('srv2')).toBe(false)
  })

  it('invalidateCredentials keeps the sealed shape', async () => {
    const store = stubChromeStorage()
    const provider = new ChromeOAuthProvider('srv', URL_A)
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
    const provider = new ChromeOAuthProvider('srv', URL_A)
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
    const provider = new ChromeOAuthProvider('srv', URL_A)
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
    const provider = new ChromeOAuthProvider('srv', URL_A)
    await provider.saveTokens(TOKENS)

    await withVaultDown(async () => {
      await provider.invalidateCredentials('all')
      expect(store['mcpAuth:srv']).toBeUndefined()
    })

    expect(await hasStoredAuth('srv')).toBe(false)
  })

  it('a save while nothing was ever stored succeeds even with the vault down (nothing to lose)', async () => {
    stubChromeStorage()
    const provider = new ChromeOAuthProvider('srv', URL_A)
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
    const provider = new ChromeOAuthProvider('srv', URL_A) // opts.interactive left unset
    await expect(provider.redirectToAuthorization(new URL('https://example.com/authorize'))).rejects.toThrow(
      UnauthorizedError,
    )
    expect(launch).not.toHaveBeenCalled()
  })

  it('an interactive provider launches the web auth flow and captures the code once', async () => {
    const provider = new ChromeOAuthProvider('srv', URL_A, { interactive: true })
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
    const provider = new ChromeOAuthProvider('srv', URL_A, { interactive: true })
    provider.state()
    stubChromeIdentity((_details, callback) => {
      callback('https://abc123.chromiumapp.org/mcp?code=test-code-1&state=not-the-expected-state')
    })
    await expect(provider.redirectToAuthorization(new URL('https://example.com/authorize'))).rejects.toThrow(
      'state mismatch',
    )
  })

  it('a redirect with no code is rejected', async () => {
    const provider = new ChromeOAuthProvider('srv', URL_A, { interactive: true })
    stubChromeIdentity((_details, callback) => {
      callback('https://abc123.chromiumapp.org/mcp?state=xyz')
    })
    await expect(provider.redirectToAuthorization(new URL('https://example.com/authorize'))).rejects.toThrow(
      'carried no code',
    )
  })

  it("a redirect carrying the server's error param is rejected", async () => {
    const provider = new ChromeOAuthProvider('srv', URL_A, { interactive: true })
    stubChromeIdentity((_details, callback) => {
      callback('https://abc123.chromiumapp.org/mcp?error=access_denied&error_description=User%20said%20no')
    })
    await expect(provider.redirectToAuthorization(new URL('https://example.com/authorize'))).rejects.toThrow(
      'User said no',
    )
  })
})

// Regression coverage for the token-replay fix: a bearer token issued for one
// URL must never reach a different URL parked under the same server name.
describe('token scoping (boundUrl)', () => {
  it('a token saved for one URL is never handed to a provider for the same name at a different URL', async () => {
    const store = stubChromeStorage()
    const providerA = new ChromeOAuthProvider('srv', URL_A)
    await providerA.saveTokens(TOKENS)
    await providerA.saveClientInformation(CLIENT_INFO)
    expect(store['mcpAuth:srv']).toBeDefined()

    // Same display name, now pointed at a different origin — e.g. the user
    // repointed the server, or a shared config reused a familiar name.
    const providerB = new ChromeOAuthProvider('srv', URL_B)
    expect(await providerB.tokens()).toBeUndefined()
    expect(await providerB.clientInformation()).toBeUndefined()
    await expect(providerB.codeVerifier()).rejects.toThrow('No PKCE verifier saved')

    // The mismatched record self-purges on that first touch — it can never
    // be adopted by yet another future server under this name either.
    expect(store['mcpAuth:srv']).toBeUndefined()
  })

  it('a normal reconnect with an unchanged URL keeps its token (no false purge)', async () => {
    const store = stubChromeStorage()
    const provider = new ChromeOAuthProvider('srv', URL_A)
    await provider.saveTokens(TOKENS)

    // A fresh provider instance for the same name AND the same URL — what a
    // routine reconnect constructs (see manager.ts's connect()).
    const reconnected = new ChromeOAuthProvider('srv', URL_A)
    expect(await reconnected.tokens()).toEqual(TOKENS)
    expect(store['mcpAuth:srv']).toBeDefined()
  })

  it('a legacy pre-fix record (no boundUrl at all) is never treated as a match, for any URL', async () => {
    const store = stubChromeStorage()
    store['mcpAuth:srv'] = { tokens: TOKENS } // shape written before this fix existed
    const provider = new ChromeOAuthProvider('srv', URL_A)
    expect(await provider.tokens()).toBeUndefined()
    expect(store['mcpAuth:srv']).toBeUndefined() // evicted on first touch
  })

  it('saving under a new URL does not carry forward a different URL\'s stale fields', async () => {
    stubChromeStorage()
    const providerA = new ChromeOAuthProvider('srv', URL_A)
    await providerA.saveTokens(TOKENS)
    await providerA.saveClientInformation(CLIENT_INFO)

    // The server is repointed to URL_B and a fresh OAuth flow saves just a
    // code verifier so far. That save must not resurrect URL_A's tokens
    // under URL_B's binding.
    const providerB = new ChromeOAuthProvider('srv', URL_B)
    await providerB.saveCodeVerifier('pkce-for-b')
    expect(await providerB.codeVerifier()).toBe('pkce-for-b')
    expect(await providerB.tokens()).toBeUndefined()
    expect(await providerB.clientInformation()).toBeUndefined()
  })

  it('removing then re-adding a server under the same name does not inherit the old token', async () => {
    stubChromeStorage()
    const first = new ChromeOAuthProvider('srv', URL_A)
    await first.saveTokens(TOKENS)
    expect(await first.tokens()).toEqual(TOKENS)

    // Removal (McpManager.refresh's slot-deletion path — see manager.ts)
    // purges by name outright, regardless of URL.
    await clearAuth('srv')

    // Re-added under the identical name AND URL: boundUrl alone would still
    // match here, so this proves the explicit removal purge — not boundUrl —
    // is what severs the inheritance.
    const second = new ChromeOAuthProvider('srv', URL_A)
    expect(await second.tokens()).toBeUndefined()
  })

  it('invalidateCredentials never mutates and re-persists a record bound to a different URL', async () => {
    // This does NOT rely on the SDK's own call ordering (auth()'s catch
    // handler only reaches invalidateCredentials after clientInformation()/
    // tokens() have already run in the same flow, which would have
    // self-evicted a mismatch first) — it calls invalidateCredentials
    // directly, as a defensive test of this method's OWN boundary, since an
    // SDK upgrade could reorder that call chain silently.
    const store = stubChromeStorage()
    const providerA = new ChromeOAuthProvider('srv', URL_A)
    await providerA.saveTokens(TOKENS)
    await providerA.saveClientInformation(CLIENT_INFO)

    const providerB = new ChromeOAuthProvider('srv', URL_B)
    await providerB.invalidateCredentials('tokens')

    // Without the fix, this would read A's record (unscoped), delete just
    // its `tokens` field, and re-persist the rest — i.e. `store['mcpAuth:srv']`
    // would still exist, now holding `{clientInformation: CLIENT_INFO,
    // boundUrl: URL_A}`: B successfully mutated a record it has no business
    // touching. Fixed, the mismatched record is evicted wholesale (the same
    // outcome as any other boundUrl-mismatched read) rather than selectively
    // edited under an identity it doesn't belong to.
    expect(store['mcpAuth:srv']).toBeUndefined()
  })

  it('invalidateCredentials still works normally when the record matches this provider\'s URL', async () => {
    stubChromeStorage()
    const provider = new ChromeOAuthProvider('srv', URL_A)
    await provider.saveTokens(TOKENS)
    await provider.saveCodeVerifier('pkce-1')
    await provider.invalidateCredentials('tokens')
    expect(await provider.tokens()).toBeUndefined()
    expect(await provider.codeVerifier()).toBe('pkce-1')
  })
})

describe('exported config never carries auth state', () => {
  it('serializeMcpJson output contains no token, client secret, or boundUrl even after OAuth has run', async () => {
    stubChromeStorage()
    const provider = new ChromeOAuthProvider('linear', URL_A)
    await provider.saveTokens(TOKENS)
    await provider.saveClientInformation(CLIENT_INFO)

    const servers: Record<string, McpServerEntry> = { linear: { url: URL_A } }
    const json = serializeMcpJson(servers)
    expect(json).not.toContain('at-1') // TOKENS.access_token
    expect(json).not.toContain('rt-1') // TOKENS.refresh_token
    expect(json).not.toContain('test-client-secret')
    expect(json).not.toContain('boundUrl')
    expect(JSON.parse(json)).toEqual({ mcpServers: servers })
  })
})
