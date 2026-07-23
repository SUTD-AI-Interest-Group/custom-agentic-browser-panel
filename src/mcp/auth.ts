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

import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

interface StoredAuth {
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
}

const keyFor = (server: string) => `mcpAuth:${server}`

async function load(server: string): Promise<StoredAuth> {
  const key = keyFor(server)
  const data = await chrome.storage.local.get(key)
  return (data[key] as StoredAuth | undefined) ?? {}
}

async function save(server: string, patch: Partial<StoredAuth>): Promise<void> {
  const current = await load(server)
  await chrome.storage.local.set({ [keyFor(server)]: { ...current, ...patch } })
}

/** Forget a server's tokens, registration and in-flight verifier ("sign out"). */
export async function clearAuth(server: string): Promise<void> {
  await chrome.storage.local.remove(keyFor(server))
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
    return (await load(this.server)).clientInformation
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await save(this.server, { clientInformation })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await load(this.server)).tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await save(this.server, { tokens })
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await save(this.server, { codeVerifier })
  }

  async codeVerifier(): Promise<string> {
    const v = (await load(this.server)).codeVerifier
    if (!v) throw new Error('No PKCE verifier saved — restart the authorization flow.')
    return v
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all') return clearAuth(this.server)
    const current = await load(this.server)
    if (scope === 'client') delete current.clientInformation
    if (scope === 'tokens') delete current.tokens
    if (scope === 'verifier') delete current.codeVerifier
    await chrome.storage.local.set({ [keyFor(this.server)]: current })
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
