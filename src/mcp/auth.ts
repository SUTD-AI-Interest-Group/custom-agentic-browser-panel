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
// Token-scoping invariant: storage is still keyed by the server's display NAME
// (`mcpAuth:<name>`, unchanged — see keyFor) so `clearAuth(name)` stays a
// stable, name-addressable operation for callers like
// resetSettingsKeepingProviders (src/data/settings.ts) that only ever have a
// name to work with. But a NAME is mutable and reusable — the user can point
// "linear" at a different origin, or delete "linear" and add a totally
// different server under that same name later — while a bearer token is only
// ever valid for the origin that issued it. Reusing the name as the sole
// identifier would let a token minted for one endpoint get replayed against
// whatever now sits under that name. So every StoredAuth record additionally
// carries `boundUrl`: the exact resource URL it was issued for. save() (via
// ChromeOAuthProvider's constructor `resourceUrl`) stamps it on every write,
// and every read (`tokens`/`clientInformation`/`codeVerifier`, via
// loadBound()) refuses anything whose `boundUrl` doesn't match the URL the
// provider was constructed with — including a legacy pre-fix record that has
// no `boundUrl` at all, which can therefore never again match any real URL
// and is evicted the first time it's touched. That closes the hole even for
// installs that already had a repointed/reused name before this fix shipped;
// no separate migration step is needed. src/mcp/manager.ts additionally
// purges auth explicitly on an entry's URL change and on server removal
// (before the eviction-on-read path would ever run) — belt and suspenders,
// and what makes "remove, then re-add the same name" a clean slate even when
// the new entry happens to reuse the exact same URL (boundUrl alone would
// still match there; the explicit removal purge is what severs it).
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
  /**
   * The exact resource URL these credentials were issued for/against. See the
   * "Token-scoping invariant" above — every write stamps it, every read
   * requires it to match. Absent on any record written before this field
   * existed; that is deliberately never treated as a match (see loadBound).
   */
  boundUrl?: string
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
 * Merge a patch onto the stored record, scoped to `resourceUrl`. Refuses to
 * write while `load()` reports `locked`: persisting `{...{}, ...patch}` in
 * that state would silently replace a still-sealed (recoverable) blob with a
 * record holding only this call's own field(s) — permanent data loss from a
 * transient hiccup. The rejected promise is an ordinary failure to every
 * current call site (the SDK's OAuth orchestrator, awaited from manager.ts's
 * connect()/authorize()), which already turns any thrown error into a
 * retryable `needs-auth`/`error` status — a recoverable failure beats silent
 * data loss.
 *
 * When the record on disk was bound to a DIFFERENT url (or has no `boundUrl`
 * at all — legacy), `current`'s other fields must NOT be carried forward:
 * merging a patch onto them would silently re-bind an unvalidated, possibly
 * stale credential (e.g. `tokens` from a prior url) to this url just because
 * some unrelated field (say `codeVerifier`) happened to be saved here next.
 * Starting clean in that case is what makes `boundUrl` actually load-bearing
 * on the write side, not just the read side (loadBound).
 */
async function save(server: string, resourceUrl: string, patch: Partial<StoredAuth>): Promise<void> {
  const { auth: current, locked } = await load(server)
  if (locked) throw new Error('MCP auth vault is temporarily unavailable — try again shortly.')
  const base = current.boundUrl === resourceUrl ? current : {}
  await persist(server, { ...base, ...patch, boundUrl: resourceUrl })
}

/** Forget a server's tokens, registration and in-flight verifier ("sign out"). */
export async function clearAuth(server: string): Promise<void> {
  await chrome.storage.local.remove(keyFor(server))
}

/**
 * Read the stored auth for `server`, valid only if it was bound to
 * `resourceUrl` (see the "Token-scoping invariant" file comment). A mismatch
 * — including a legacy record with no `boundUrl` at all — is treated as
 * "nothing here" and the stale entry is evicted on the spot, so this
 * self-heals the first time anything actually tries to read it; no separate
 * migration pass is needed. Only evicts when there is something to evict
 * (`hasAny`), so a server that has simply never authorized doesn't pay a
 * storage write on every single read.
 */
async function loadBound(server: string, resourceUrl: string): Promise<LoadResult> {
  const result = await load(server)
  if (result.locked) return result
  const hasAny = Boolean(result.auth.tokens || result.auth.clientInformation || result.auth.codeVerifier)
  if (hasAny && result.auth.boundUrl !== resourceUrl) {
    await clearAuth(server).catch(() => {})
    return { auth: {}, locked: false }
  }
  return result
}

/**
 * Whether a server has stored tokens (drives the Sign-out button) — reads
 * both at-rest shapes. Deliberately reports `false` while the vault is
 * locked, same as "nothing decryptable yet": we cannot tell whether the
 * still-sealed blob actually holds a `tokens` field without opening it. This
 * function never writes, so a stale-until-vault-recovers "no auth" reading
 * costs nothing — unlike the write path, there is no data-loss risk here.
 *
 * Deliberately NOT `boundUrl`-scoped (unlike ChromeOAuthProvider's own
 * getters): this only drives a UI hint, never a credential that reaches a
 * server, and by the time a settings row renders, the manager's own connect
 * attempt has typically already run and self-evicted any stale record via
 * loadBound — so this stays a plain presence check, not a security boundary.
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

  /**
   * `resourceUrl` is the exact URL this provider instance is currently
   * connecting to — always `slot.entry.url` at construction time in
   * manager.ts. It is NOT the storage key (that's still `server`, the
   * display name — see keyFor); it's the value every read/write validates
   * against, per the "Token-scoping invariant" file comment.
   */
  constructor(
    private server: string,
    private resourceUrl: string,
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
    return (await loadBound(this.server, this.resourceUrl)).auth.clientInformation
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await save(this.server, this.resourceUrl, { clientInformation })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await loadBound(this.server, this.resourceUrl)).auth.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await save(this.server, this.resourceUrl, { tokens })
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await save(this.server, this.resourceUrl, { codeVerifier })
  }

  async codeVerifier(): Promise<string> {
    const v = (await loadBound(this.server, this.resourceUrl)).auth.codeVerifier
    if (!v) throw new Error('No PKCE verifier saved — restart the authorization flow.')
    return v
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    // 'all' is an explicit full wipe: the caller's whole intent is "delete
    // everything," so there is nothing to protect and no need to see (let
    // alone decrypt) the existing record — this proceeds even while locked.
    if (scope === 'all') return clearAuth(this.server)
    // Routed through loadBound, not load(): a single-scope delete reads,
    // mutates and re-persists "the rest of the record" — if that record
    // belongs to a DIFFERENT resourceUrl, this would edit and hand back a
    // credential this provider has no business touching, the same hole the
    // other three getters close. In practice this method is currently only
    // ever reached via the SDK's auth() catch handler, which by then has
    // already called clientInformation()/tokens() in the same flow — so a
    // mismatched record would already be self-evicted by loadBound before
    // getting here. That ordering lives in a dependency we don't control
    // (@modelcontextprotocol/sdk), and an upgrade could change it silently —
    // so this enforces the same boundary directly rather than relying on it.
    const { auth: current, locked } = await loadBound(this.server, this.resourceUrl)
    // A single-scope delete has to merge onto the REST of the record. While
    // locked we can't see the rest (it's still sealed, unreadable right now),
    // so `current` would come back `{}` and persisting it would wipe every
    // field, not just this scope's — the sharper variant of the save() bug
    // above. Refuse instead of guessing.
    if (locked) throw new Error('MCP auth vault is temporarily unavailable — try again shortly.')
    // Nothing bound to this url — either genuinely never authorized, or a
    // mismatched record loadBound just evicted — either way there is nothing
    // of THIS provider's to invalidate.
    if (!current.boundUrl) return
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
