// OAuth for MCP servers, on Chrome extension primitives. The SDK drives the
// whole OAuth 2.1 dance — protected-resource discovery, dynamic client
// registration, PKCE, token exchange, refresh — through the OAuthClientProvider
// interface; this file is the Chrome-shaped implementation: tokens live in
// chrome.storage.local (NEVER in the exportable settings JSON), and the
// user-agent redirect happens via chrome.identity.launchWebAuthFlow.
//
// The interactivity rule: an auth POPUP may only ever appear from an explicit
// user click (the Authorize button / card action). Background connects get a
// non-interactive provider whose redirectToAuthorization refuses — the SDK then
// surfaces UnauthorizedError and the manager parks the server at `needs-auth`
// instead of popping a window uninvited. Token REFRESH is silent and needs no
// interaction, so persisted sessions keep working across restarts.
//
// Vault-outage invariant: StoredAuth is sealed as ONE JSON blob (unlike
// settingsVault.ts's field-level sealing), so there is no "still sealed,
// re-sealing is a no-op" passthrough available to a caller that needs to
// merge a patch onto it. load() therefore reports a `locked` flag whenever
// the vault is transiently down and the stored blob is intact-but-unreadable
// right now; save()/invalidateCredentials(scope) refuse to persist while
// locked, rather than merging the patch onto a falsely-"empty" record and
// destroying whatever was already sealed. See CLAUDE.md "Secrets are sealed
// at rest."

import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { openSecret, sealSecret } from '../data/vault'
import { isSealed } from '../data/vaultFormat'

interface StoredAuth {
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
}

/** At-rest shape since the vault: the whole StoredAuth JSON sealed as one unit. */
interface SealedStoredAuth {
  v: 1
  sealed: string
}

function isSealedShape(value: unknown): value is SealedStoredAuth {
  return typeof value === 'object' && value !== null && typeof (value as SealedStoredAuth).sealed === 'string'
}

const keyFor = (server: string) => `mcpAuth:${server}`

/**
 * `locked` distinguishes "nothing recoverable here" (auth genuinely absent, or
 * a sealed blob that positively fails to decrypt — lost KEK/corrupt, re-auth
 * is correct) from "something IS sealed but the vault is transiently
 * unreachable right now." Collapsing both to an empty `auth` — the pre-fix
 * behavior — is exactly what let a save during an outage destroy already-
 * sealed tokens: every mutator merges a patch onto this result and persists
 * the merge, so a falsely-empty `auth` silently narrows the stored record
 * down to just the new patch's field(s). `locked` is the guard that stops it.
 */
interface LoadResult {
  auth: StoredAuth
  locked: boolean
}

async function load(server: string): Promise<LoadResult> {
  const key = keyFor(server)
  const data = await chrome.storage.local.get(key)
  const stored = data[key] as StoredAuth | SealedStoredAuth | undefined
  if (!stored) return { auth: {}, locked: false }
  if (isSealedShape(stored)) {
    const json = await openSecret(stored.sealed)
    if (json === null) return { auth: {}, locked: false } // lost KEK / corrupt — nothing recoverable, re-auth is correct
    // openSecret's vault-down branch returns the sealed input unchanged (see
    // vault.ts's `if (!dek) return value`) — still `lysec1.`-prefixed. That,
    // not an empty result, is the signal a save must never be allowed to
    // overwrite.
    if (isSealed(json)) return { auth: {}, locked: true }
    try {
      return { auth: JSON.parse(json) as StoredAuth, locked: false }
    } catch {
      return { auth: {}, locked: false } // decrypted but not valid JSON — shouldn't happen; fail safe like before
    }
  }
  return { auth: stored, locked: false } // legacy plaintext record — resealed by the next persist()
}

/** Write the full record, sealed. Falls back to the legacy plaintext shape when the vault is down. */
async function persist(server: string, auth: StoredAuth): Promise<void> {
  const sealed = await sealSecret(JSON.stringify(auth))
  const value: SealedStoredAuth | StoredAuth = isSealed(sealed) ? { v: 1, sealed } : auth
  await chrome.storage.local.set({ [keyFor(server)]: value })
}

/**
 * Merge a patch onto the stored record. Refuses to write while `load()`
 * reports `locked`: persisting `{...{}, ...patch}` in that state would
 * silently replace a still-sealed (recoverable) blob with a record holding
 * only this call's own field(s) — permanent data loss from a transient
 * hiccup. The rejected promise is an ordinary failure to every current call
 * site (the SDK's OAuth orchestrator, awaited from manager.ts's connect()/
 * authorize()), which already turns any thrown error into a retryable
 * `needs-auth`/`error` status — a recoverable failure beats silent data loss.
 */
async function save(server: string, patch: Partial<StoredAuth>): Promise<void> {
  const { auth: current, locked } = await load(server)
  if (locked) throw new Error('MCP auth vault is temporarily unavailable — try again shortly.')
  await persist(server, { ...current, ...patch })
}

/** Forget a server's tokens, registration and in-flight verifier ("sign out"). */
export async function clearAuth(server: string): Promise<void> {
  await chrome.storage.local.remove(keyFor(server))
}

/**
 * Whether a server has stored tokens (drives the Sign-out button) — reads
 * both at-rest shapes. Deliberately reports `false` while the vault is
 * locked, same as "nothing decryptable yet": we cannot tell whether the
 * still-sealed blob actually holds a `tokens` field without opening it. This
 * function never writes, so a stale-until-vault-recovers "no auth" reading
 * costs nothing — unlike the write path, there is no data-loss risk here.
 */
export async function hasStoredAuth(server: string): Promise<boolean> {
  return Boolean((await load(server)).auth.tokens)
}

/** MV3 promise shim over launchWebAuthFlow (callback form, for older @types). */
function launchWebAuthFlow(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirect) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else if (!redirect) reject(new Error('Authorization was cancelled.'))
      else resolve(redirect)
    })
  })
}

export class ChromeOAuthProvider implements OAuthClientProvider {
  private expectedState?: string
  private authorizationCode?: string

  constructor(
    private server: string,
    private opts: { interactive?: boolean } = {},
  ) {}

  get redirectUrl(): string {
    // https://<extension-id>.chromiumapp.org/mcp — the sentinel host
    // launchWebAuthFlow intercepts; registered with the server via DCR.
    return chrome.identity.getRedirectURL('mcp')
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Lychee AI',
      client_uri: 'https://github.com/lychee-ai',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // A browser extension is a public client: no secret to keep.
      token_endpoint_auth_method: 'none',
    }
  }

  state(): string {
    this.expectedState = crypto.randomUUID()
    return this.expectedState
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await load(this.server)).auth.clientInformation
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await save(this.server, { clientInformation })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await load(this.server)).auth.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await save(this.server, { tokens })
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await save(this.server, { codeVerifier })
  }

  async codeVerifier(): Promise<string> {
    const v = (await load(this.server)).auth.codeVerifier
    if (!v) throw new Error('No PKCE verifier saved — restart the authorization flow.')
    return v
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    // 'all' is an explicit full wipe: the caller's whole intent is "delete
    // everything," so there is nothing to protect and no need to see (let
    // alone decrypt) the existing record — this proceeds even while locked.
    if (scope === 'all') return clearAuth(this.server)
    const { auth: current, locked } = await load(this.server)
    // A single-scope delete has to merge onto the REST of the record. While
    // locked we can't see the rest (it's still sealed, unreadable right now),
    // so `current` would come back `{}` and persisting it would wipe every
    // field, not just this scope's — the sharper variant of the save() bug
    // above. Refuse instead of guessing.
    if (locked) throw new Error('MCP auth vault is temporarily unavailable — try again shortly.')
    if (scope === 'client') delete current.clientInformation
    if (scope === 'tokens') delete current.tokens
    if (scope === 'verifier') delete current.codeVerifier
    await persist(this.server, current)
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.opts.interactive) {
      // Background connect: never pop a window. The manager turns this into the
      // `needs-auth` status and the user clicks Authorize when they choose.
      throw new UnauthorizedError('Interactive authorization required.')
    }
    const redirect = await launchWebAuthFlow(authorizationUrl.toString())
    const params = new URL(redirect).searchParams
    const err = params.get('error')
    if (err) throw new Error(`Authorization failed: ${params.get('error_description') ?? err}`)
    const code = params.get('code')
    if (!code) throw new Error('The authorization response carried no code.')
    const state = params.get('state')
    if (this.expectedState && state !== this.expectedState)
      throw new Error('Authorization state mismatch — the response was not for this request.')
    this.authorizationCode = code
  }

  /** The code captured by redirectToAuthorization, consumed once by the manager. */
  takeAuthorizationCode(): string | undefined {
    const code = this.authorizationCode
    this.authorizationCode = undefined
    return code
  }
}
