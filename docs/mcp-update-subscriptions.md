# Browser-only MCP update subscriptions

Lychee supports **MCP protocol revision 2026-07-28** for remote HTTP servers, while retaining the existing MCP 1.x SDK adapter for legacy servers. This is a protocol migration, not a package-major-version rename. The 1.x SDK remains for legacy transports, authorization, and existing result types.

## Enable it

1. Open the side panel, then Settings → Connections → MCP servers.
2. Add/connect the server as usual. It must support 2026-07-28 for modern subscriptions.
3. Expand **Update subscriptions** and enable **Listen for server updates**.
4. Select the listed resource URIs whose changes you want to see. Catalog changes are requested automatically, subject to the server's advertised capabilities and acknowledgement.

Tool/resource/prompt catalog changes refresh the local catalog. Resource updates appear as URI-only notices in the chat's **MCP resource updates** inbox. Ask the agent to read a resource through the existing approval-gated `ReadMcpResource` tool when desired. A notification does not read the resource, send its contents to a model, run a tool, or start an agent turn. Multiple updates for a URI coalesce; the inbox holds at most 100 URIs and is not a message history.

## Transport and lifecycle

- Modern discovery uses `server/discover`, with protocol version, client identity and capabilities in each request's `_meta` and required HTTP headers.
- Modern requests do not use `initialize`, sessions, GET notification streams, SSE event IDs, or `Last-Event-ID`.
- `subscriptions/listen` opens an outbound POST response stream directly from the side panel. The first message must acknowledge the selected filters; all notifications must match the listen request ID and accepted filters.
- Catalog filters follow `tools.listChanged`, `resources.listChanged`, and `prompts.listChanged`. URI filters require `resources.subscribe`. There is no invented top-level `subscriptions` capability.
- Disconnected streams reconnect with exponential backoff and a fresh request ID. Catalogs refresh after every acknowledgement because updates missed during a gap cannot be replayed. Graceful server completion stops the subscription. Resource content changes during gaps are not reconstructed automatically; read the resource to resynchronize.
- Turning subscriptions off, removing/disabling a server, changing its configuration, signing out, or closing the panel aborts streams. Endpoint/account-bound consent prevents an old server's private resource URIs from being sent to a replacement server. A credential change across panel sessions can require a new opt-in; prior selections are not transferred to the new scope.
- OAuth refresh remains noninteractive and limited to the same stored session. A failed refresh exposes the existing Authorize flow; it never opens a popup on its own. Tool calls are not automatically replayed after a network failure or uncertain outcome.

## Browser-only boundaries

No backend, companion process, public callback receiver, new extension permissions, browser flags, or keepalive tricks are added. The existing side-panel lifetime is preserved: **updates run while the panel is alive**, not guaranteed always-on background delivery. Chrome may unload extension contexts. Reopening the panel reconnects using saved configuration and consent.

These are **core update subscriptions**, not the experimental OpenAI MCP Events webhook extension. No `events/subscribe` endpoint, webhook secret, or public HTTP listener is implemented. A room/chat can be monitored only if its MCP server exposes an appropriate subscribable resource; Lychee does not invent a message event API for servers lacking one.

Sampling and roots remain unsupported. Post-0.5.0 development adds bounded interactive elicitation/MRTR, negotiated durable tasks and remote skills; see [their implementation guide](mcp-interactive-tasks-skills.md). These features never fabricate user approval or blindly replay an uncertain tool execution.

Modern response parsing is bounded and rejects malformed/cross-request results. HTTP header mirroring supports primitive `x-mcp-header` schema annotations and Base64 sentinel encoding. Invalid annotations exclude the tool. Pagination is bounded; legacy missing `resultType` remains handled by the legacy SDK. Subscription payloads and server-provided metadata remain untrusted.

## Verification

Run `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, and `npm run build`. The lockfile repair adds missing platform-specific optional packages and corrects the root package version without upgrading existing locked dependency versions.

Focused tests cover modern/legacy selection, headers, JSON/SSE, cancellation races, reconnect/backoff, auth refresh, malformed/unsolicited notifications, explicit opt-in, endpoint changes, metadata-only resource notices, catalog refresh, stale-result protection, and bounded interactive MRTR. See `src/mcp/modern.test.ts`, `src/mcp/manager.modern.test.ts`, and the existing MCP suites.

Mock transport tests do not prove interoperability with a particular production MCP server. Load the built unpacked extension in a compatible Chrome and verify a real 2026-07-28 server before release. The original cloud browser restriction was later superseded by installed Chrome/local-model testing; see the [journey verification](verification/2026-10-14-journey-fixes.md) for observed scenarios and remaining external-account limits.

## Primary references

- [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)
- [MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)
- [OpenAI MCP Events, a different webhook profile](https://developers.openai.com/plugins/build/mcp-events)

## Reconciled implementation (14 October 2026)

This integrates the remote MCP portion of draft PR #2 onto the committed native
WebMCP implementation (`bfabd84`). The draft's parallel `webMcp.ts`, `SiteTools`
and `site_` tools are deliberately excluded. The existing `DiscoverWebMcp`,
`RunWebMcp`, toolbar badges and welcome suggestions remain the sole page-native
adapter. No ChatGPT provider, companion, nativeMessaging permission or backend
is included in this change.

The bounded modern transport is retained from the draft; SDK 1.32.1 is locked for
legacy HTTP/SSE and OAuth after the security dependency updates. This is protocol
2026-07-28 support, not an SDK-v2 migration or support for every optional extension.
PR #3 subsequently added elicitation, Tasks and Skills; the submitted 0.5.0 archive
predates those additions. See the [development handoff](development-handoff.md).

Both modern and legacy catalogs follow pagination with page/item/cursor limits.
Modern read/list responses with valid `ttlMs` and `cacheScope` hints can be reused
within that client instance (up to 16 entries, at most five minutes). No response
cache is shared between accounts or endpoints. Notifications, reconnect
acknowledgements, authorization failure and teardown invalidate it. Historical,
name-keyed disk catalog contents are not exposed before a live refresh.

### OAuth upgrades

The Chrome OAuth provider validates the discovered authorization server's issuer,
binds stored registration/tokens/verifiers to that issuer and the exact MCP
resource URL, and discards credentials when the issuer changes. Before accepting
a callback (including an error), it checks the callback target, state, duplicate
parameters and RFC 9207 `iss`. A missing `iss` is rejected when the authorization
server advertised it as required. Metadata's issuer flag is retained before the
legacy SDK's parser can strip it. New registrations declare `application_type:
web` and remain public clients without a client secret. Native Chrome identity
callbacks and the existing local encrypted vault are used throughout.

Scope challenges are surfaced through the explicit Authorize flow. An operation
is not silently replayed on insufficient scope. Token refresh stays noninteractive;
network failure or uncertain execution does not trigger tool replay.

### Client ID Metadata Documents (CIMD)

An MCP server entry may set `oauthClientMetadataUrl` to a public HTTPS JSON
metadata document. When its authorization server supports CIMD, the SDK uses
that URL as the client ID instead of registering dynamically. DCR remains the
compatibility path when no CIMD URL is configured or the server lacks support.

`site/public/oauth-client.json` is the ready-to-deploy document for the published
extension ID. It is a static public file, not a middleware service. **It has not
been deployed by this change**, so it is not enabled as an automatic default.
After publishing and verifying the file, configure a production server entry:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauthClientMetadataUrl": "https://lychee-ai.netlify.app/oauth-client.json"
    }
  }
}
```

Sign out and authorize again when changing registration strategy. An unpacked
extension uses a different redirect URI: use a document listing that installation's
exact `chrome.identity.getRedirectURL('mcp')`, or leave CIMD unset and use DCR.
The metadata URL must be reachable by the authorization server, not merely by the
browser. No tokens or private keys belong in this public document.

### Reproducible browser check

Run `node scripts/mcp-browser-smoke.mjs` and open the printed loopback URL. It
bundles the actual manager/provider and tests modern negotiation, legacy fallback,
tool calls, subscriptions and OAuth against a local HTTP fixture under CSP without
`unsafe-eval`. Chrome storage/identity and the login popup are fixtures; transport,
browser fetch, PKCE and the encrypted vault run in the browser. It does not use a
real account, provider, model, or third-party intermediary. Stop the command when
finished. This check does not establish interoperability with every production
MCP server or live Chrome identity consent.

### Validation result — 14 October 2026

- Full suite: 150 files / 2,014 tests passed, excluding all uncommitted ChatGPT-provider work.
- Production TypeScript and both extension bundles passed; existing bundle-size warnings remain.
- Native browser fixture passed under strict CSP: modern and legacy negotiation,
  tool calls, subscription acknowledgement/resource notice, insufficient-scope
  consent flow, OAuth discovery/DCR/PKCE/issuer callback/token exchange.
- The real SDK OAuth flow with CIMD passed a mocked-network regression test and
  made no dynamic registration request.
- `git diff --check` passed. The previously committed WebMCP adapter, badges,
  welcome view and tests are retained; no parallel draft adapter is installed.
- Live production server interoperability, real Chrome identity consent and the
  public deployment of the CIMD file remain unverified.
