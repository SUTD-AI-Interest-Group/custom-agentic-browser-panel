# Browser-only MCP update subscriptions

Lychee supports **MCP protocol revision 2026-07-28** for remote HTTP servers, while retaining the existing MCP 1.x SDK adapter for legacy servers. This is a protocol migration, not a package-major-version rename. The 1.x SDK remains for legacy transports, authorization, and existing result types.

## Enable it

1. Open the side panel, then Settings → General → MCP servers.
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

The client advertises no sampling, roots or elicitation capability. An `input_required` MRTR result fails with a clear unsupported-interaction error; Lychee does not fabricate user approval, invoke models, disclose local files, or blindly retry. Full interactive MRTR handling is deliberately outside this migration.

Modern response parsing is bounded and rejects malformed/cross-request results. HTTP header mirroring supports primitive `x-mcp-header` schema annotations and Base64 sentinel encoding. Invalid annotations exclude the tool. Pagination is bounded; legacy missing `resultType` remains handled by the legacy SDK. Subscription payloads and server-provided metadata remain untrusted.

## Verification

Run `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, and `npm run build`. The lockfile repair adds missing platform-specific optional packages and corrects the root package version without upgrading existing locked dependency versions.

Focused tests cover modern/legacy selection, headers, JSON/SSE, cancellation races, reconnect/backoff, auth refresh, malformed/unsolicited notifications, explicit opt-in, endpoint changes, metadata-only resource notices, catalog refresh, stale-result protection, and unsupported MRTR. See `src/mcp/modern.test.ts`, `src/mcp/manager.modern.test.ts`, and the existing MCP suites.

Mock transport tests do not prove interoperability with a particular production MCP server. Load the built unpacked extension in a compatible Chrome and verify a real 2026-07-28 server before release. A cloud Chromium process-singleton socket restriction prevented real extension browser QA in the implementation environment.

## Primary references

- [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)
- [MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)
- [OpenAI MCP Events, a different webhook profile](https://developers.openai.com/plugins/build/mcp-events)
