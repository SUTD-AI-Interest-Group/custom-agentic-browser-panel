# MCP Support — Design

Date: 2026-07-24. Approved by user (approach + sections 1–6 individually; 7–9 wholesale with "lgtm go ahead and build it").

## Goal

Lychee AI gains Model Context Protocol support: users configure remote MCP servers
(standard `mcpServers` JSON — upload / edit / one-click copy), authorize OAuth
servers, and the chat agent consumes the **full protocol surface** — tools,
resources, and prompts — with rich content (text / image / audio / video / HTML)
and interactive **MCP Apps** rendered in iframes.

## Decisions (user-approved)

- **Full MCP surface**: tools + resources + prompts.
- **stdio entries**: preserved verbatim in config, shown greyed-out as not
  runnable in a browser (hint: local HTTP bridge like `mcp-proxy`). No native
  host companion.
- **Foreground chat only**: MCP tools never join the background research
  pipeline (no human in the loop there).
- **Permissions**: per-server default policy + per-tool overrides (two-level,
  like provider/model reasoning effort).
- **Settings placement**: MCP section inside the **General** tab; policy rows in
  the Permissions tab.
- **Client stack**: official `@modelcontextprotocol/sdk` (v1.29.x) — browser
  `fetch`-based transports; `<all_urls>` host permission exempts CORS.
- **Out of scope**: sampling, elicitation, roots (not declared in client
  capabilities); native-messaging stdio host; research-pipeline MCP.

## Architecture

New directory `src/mcp/` for the subsystem; UI pieces in `src/ui/`.

### Config & storage (`src/mcp/config.ts` — pure, tested)

- `Settings.mcp?: McpSettings`:
  - `servers: Record<string, McpServerEntry>` — **byte-for-byte the standard
    `mcpServers` object** (remote: `url` + optional `headers`/`type`; stdio:
    `command`/`args`/`env`). Storage *is* the interchange format.
  - `serverState?: Record<string, { enabled?: boolean }>` — sidecar; absent →
    enabled.
  - `policies?: Record<string, { default?: ToolPolicy; tools?: Record<string, ToolPolicy> }>` — sidecar.
- OAuth tokens / client registration / PKCE verifier: separate
  `chrome.storage.local` keys `mcpAuth:<server>` — never exported.
- Copy = `JSON.stringify({ mcpServers }, null, 2)`. Import accepts
  `{mcpServers:{…}}` or a bare map; validates each entry (`url` xor `command`);
  valid entries merge in by name (overwrite same-named, keep rest); invalid ones
  listed inline without blocking the rest. Editor = JSON textarea with live
  validation, Save disabled while invalid.
- Pure helpers: parse/validate/serialize/merge + `classifyEntry` →
  `'http' | 'stdio'`.

### Connection layer (`src/mcp/manager.ts`)

- One `McpManager` singleton in the **side-panel context** (same world as agent
  loop + Settings UI; dies with the panel). Not the MV3 service worker (SSE
  lifetime) and not research (out of scope).
- Per enabled remote server: SDK `Client` over `StreamableHTTPClientTransport`,
  falling back to `SSEClientTransport` when streamable HTTP is rejected
  (standard compatibility dance).
- Lazy but eager-in-background connect on panel open; capped exponential
  backoff; disable/remove disconnects immediately. Status per server:
  `connected | connecting | needs-auth | error | disabled | unsupported` —
  drives the settings status dot.
- On connect: list tools/resources/prompts → in-memory catalog + persisted
  snapshot (`chrome.storage.local` key `mcpCatalog`) so Permissions rows and
  ToolSearch disclosure work while disconnected (first call connects on
  demand). `listChanged` notifications refresh the catalog.
- Client declares no sampling/elicitation/roots capabilities.

### OAuth (`src/mcp/auth.ts`)

- `ChromeOAuthProvider implements OAuthClientProvider` — SDK drives discovery,
  dynamic client registration, PKCE, token exchange, refresh.
- `redirectUrl` = `chrome.identity.getRedirectURL()`; manifest gains
  `identity` permission.
- `redirectToAuthorization(url)` → `chrome.identity.launchWebAuthFlow({url,
  interactive:true})` → extract `code` → `transport.finishAuth(code)` →
  reconnect.
- Interactive popups only from explicit user clicks: the **Authorize** button in
  Settings, or an inline Authorize action when a mid-chat call hits 401.
  Background reconnects never pop windows.
- Static-`headers` (API key) servers work without OAuth.

### Tools in the agent loop (`src/mcp/tools.ts`)

- Per continuation chain, `runTurnChain` merges MCP dynamic tools into the
  ToolSet: name `mcp_<server>_<tool>` sanitized to the provider-safe charset,
  hash-suffixed on collision/overflow (pure, tested).
- Merging into the ToolSet inherits both invariants: progressive disclosure
  (catalog derives from the ToolSet — a 40-tool server costs nothing until
  `GetTool`), and `requestApproval` in every `execute()` (card shows server
  badge + tool + args). `repairToolCall` self-healing works unchanged.
- Policy resolution: tool override → server default → `ask`. `never` (either
  level) removes the tool from the ToolSet entirely (unrepairable, like other
  policy-removed tools).
- Calls carry the turn's `AbortSignal` (Stop cancels in-flight requests) + a
  per-call timeout; a call to a dropped server gets one reconnect attempt, then
  a normal tool-error result.

### Rich content (`src/mcp/content.ts` — pure, tested)

Maps each MCP result's `content[]` + `structuredContent` into three streams
(image invariant honored):

- **Model (tool return, text only)**: text parts, stringified
  `structuredContent`, embedded text resources — truncation budget with
  explicit note; one-line notes for non-text parts routed elsewhere.
- **`imageQueue`**: image parts as `{dataUrl, caption}`; caption names
  server/tool and says the image is unannotated (no numbered marks).
- **User artifact cards**: images, audio (player), video + other binary
  resources (mime-typed), HTML — stored in IndexedDB with the conversation,
  rendered by `McpContentCard` (beside `ShotCard`).
- `isError: true` → ordinary tool-error text (model self-corrects).

### Resources & prompts

- Two built-in tools in `TOOL_CATALOG`, new group `mcp` ("MCP"):
  - `ListMcpResources` — resources + templates across connected servers;
    metadata-only, default `always`.
  - `ReadMcpResource` — read one by server + URI, default `ask`; content routed
    through the content mapper.
- Prompts surface in the composer slash menu beside skills as
  `/mcp:<server>:<prompt>`; no-arg prompts inject fetched messages as the
  outgoing user message; declared arguments get a small inline form first.

### MCP Apps (`src/mcp/appBridge.ts` pure protocol + sandbox page + `McpAppCard`)

- MV3 extension pages forbid inline scripts → app HTML runs in a
  **manifest-declared sandbox page** (`"sandbox"` key; own Vite entry; unique
  origin; no `chrome.*`), hosting the app in a nested `srcdoc` iframe.
- Chat renders `McpAppCard` embedding the sandbox iframe; postMessage JSON-RPC
  bridge implements the MCP Apps host protocol: init context (tool result +
  theme), size-change notifications (card height), link opens relayed to the
  panel (`chrome.tabs.create`), and app tool-call requests routed through the
  **same policy + `requestApproval` gate, scoped to the app's own server only**.
- External-URL apps (`text/uri-list`) iframe the https URL directly; fallback
  link when the site refuses framing.
- App HTML + result data persist in IndexedDB so cards survive reload.

### Errors & testing

- Connection failures → status chips + capped backoff; JSON editor blocks
  invalid saves inline; import lists bad entries.
- Vitest for the pure modules: config, tool naming, policy resolution, content
  mapping, app-bridge protocol handlers. End-to-end: `npm run build` + reload
  per `/verify-extension`.

## Implementation phases

1. Config module + settings storage + General-tab MCP section (list / add /
   remove / toggle / JSON editor / import / copy) — no connections yet.
2. Manager + transports + catalog cache + live status in settings.
3. Tool adapter + Permissions rows + content mapper + artifact cards.
4. OAuth (`ChromeOAuthProvider`, Authorize buttons, 401 inline card).
5. Resource tools + prompts in the slash menu.
6. MCP Apps: sandbox entry, bridge, `McpAppCard`, persistence.
