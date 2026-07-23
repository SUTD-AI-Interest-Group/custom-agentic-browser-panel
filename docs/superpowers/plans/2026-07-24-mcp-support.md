# MCP Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full-surface MCP support (tools, resources, prompts, OAuth, rich content, MCP Apps) per `docs/superpowers/specs/2026-07-24-mcp-support-design.md`.

**Architecture:** Official `@modelcontextprotocol/sdk` client living in the side-panel context (`McpManager` singleton), config stored as the standard `mcpServers` JSON in `Settings.mcp`, MCP tools merged into the per-turn ToolSet so they inherit progressive disclosure + the `requestApproval` gate, rich content split by a pure mapper into model-text / imageQueue / IndexedDB artifacts, MCP Apps in a manifest-sandboxed page.

**Tech Stack:** TypeScript strict, React 18, Vite 6, AI SDK v7 (`dynamicTool`/`jsonSchema`), `@modelcontextprotocol/sdk` 1.29.x, Vitest.

## Global Constraints

- ASI style: no semicolons, single quotes, 2-space indent; `interface` for shapes, `type` for unions.
- Every gated tool's `execute()` must call `requestApproval` before acting; `never` policy removes the tool from the ToolSet.
- Images reach the model ONLY via `imageQueue` (`QueuedImage {dataUrl, caption}`); tool returns carry ids, never image data.
- Pure modules get Vitest suites beside them; no Chrome/AI-SDK imports in pure modules.
- Copyable JSON must be exactly `{ "mcpServers": { ... } }` with no extension-private fields; tokens never in settings.
- Verify each phase: `npm test` + `npm run typecheck` (never `npx tsc`); commit per task.

---

### Task 1: Pure config module (`src/mcp/config.ts` + tests)

**Files:** Create `src/mcp/config.ts`, `src/mcp/config.test.ts`.

**Produces:**
- `interface McpServerEntry { url?: string; type?: string; headers?: Record<string,string>; command?: string; args?: string[]; env?: Record<string,string>; [k: string]: unknown }`
- `interface McpServerPolicy { default?: ToolPolicy; tools?: Record<string, ToolPolicy> }`
- `interface McpSettings { servers: Record<string, McpServerEntry>; serverState?: Record<string, { enabled?: boolean }>; policies?: Record<string, McpServerPolicy> }`
- `classifyEntry(e: McpServerEntry): 'http' | 'stdio' | 'invalid'` — `url` string → http; `command` string → stdio; both/neither → invalid.
- `parseMcpJson(text: string): { servers: Record<string, McpServerEntry>; invalid: { name: string; error: string }[] } | { error: string }` — accepts `{mcpServers:{…}}` or bare map; per-entry validation (http url must parse as http(s) URL).
- `serializeMcpJson(servers): string` — `JSON.stringify({ mcpServers }, null, 2)`.
- `mergeServers(current, imported): Record<string, McpServerEntry>` — overwrite by name, keep the rest.
- `serverEnabled(mcp: McpSettings|undefined, name): boolean` — sidecar, default true.
- `mcpToolPolicy(mcp, server, tool): ToolPolicy` — tool override → server default → 'ask'.
- `mcpSettings(settings: Settings): McpSettings` — `settings.mcp ?? { servers: {} }`.
- `mcpToolName(server: string, tool: string, taken: Set<string>): string` — `mcp_<server>_<tool>` sanitized `[^a-zA-Z0-9_-]→_`, ≤64 chars, dedupe with numeric suffix.
- `parseMcpToolName` NOT needed (adapter closes over server/tool).

Tests: classify (url/command/both/neither), parse (wrapped, bare, invalid JSON, invalid entries listed, valid survive), serialize round-trip, merge overwrite/keep, policy resolution (override beats default beats ask), name sanitization (dots/spaces, >64 chars truncated, collision suffix).

- [ ] Write failing tests → run (`npm test -- src/mcp/config.test.ts`) → implement → pass → commit `feat(mcp): pure config module — parse/serialize/merge/policy/naming`.

### Task 2: Settings field + storage

**Files:** Modify `src/data/settings.ts` (add `mcp?: McpSettings` to `Settings`, import type from `../mcp/config`; no migration needed — sparse field). Modify `src/data/settings.test.ts` only if load/save shape asserted.

- [ ] Add field + typecheck + commit `feat(mcp): mcp settings field`.

### Task 3: General-tab MCP section (config-only UI)

**Files:** Create `src/ui/settings/McpSection.tsx`; modify `src/ui/settings/GeneralTab.tsx` (render `<McpSection>` between Privacy and Observability); modify `src/ui/styles.css` (status dot classes, server row styles reusing provider-row patterns).

Section contents: server rows (name, transport badge http/stdio, enable toggle, remove ×), stdio rows greyed with hint; add-server form (name, url, headers as JSON-ish key:value textarea — keep to name+url+optional headers JSON); `Disclosure` "Edit JSON" containing textarea editor (live parse via `parseMcpJson`, inline error, Save disabled while invalid), Import (file input + paste into editor), Copy JSON button (`navigator.clipboard.writeText(serializeMcpJson(...))`).

- [ ] Build UI → `npm run typecheck` → commit `feat(mcp): MCP servers section in General settings`.

### Task 4: McpManager (`src/mcp/manager.ts`)

**Files:** Create `src/mcp/manager.ts`. Chrome-coupled; pure logic stays in config.ts.

**Produces:**
- `type McpStatus = 'connected' | 'connecting' | 'needs-auth' | 'error' | 'disabled' | 'unsupported'`
- `interface McpServerRuntime { name: string; status: McpStatus; error?: string; tools: McpToolInfo[]; resources: McpResourceInfo[]; prompts: McpPromptInfo[] }`
- `interface McpToolInfo { name: string; description: string; inputSchema: unknown; meta?: Record<string, unknown> }` (+ resource/prompt infos)
- `class McpManager`: `refresh(settings)` (diff config → connect/disconnect), `ensureConnected(name)`, `callTool(server, tool, args, {signal, timeoutMs})`, `readResource(server, uri)`, `getPrompt(server, name, args)`, `runtime(): McpServerRuntime[]`, `subscribe(cb)`, `authorize(name)` (phase 4), `disconnectAll()`.
- `getMcpManager(): McpManager` singleton.
- Transport: try `StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })`; on connect failure with HTTP 4xx, retry with `SSEClientTransport`. Catalog persisted to `chrome.storage.local` key `mcpCatalog` `{ [server]: { tools, resources, prompts } }`; loaded at startup so runtime() has data while disconnected. `listChanged` handlers re-list. Client capabilities: `{}`.

- [ ] Implement → typecheck → commit `feat(mcp): connection manager with transport fallback and catalog cache`.

### Task 5: Wire status into UI + lifecycle

**Files:** Modify `src/ui/settings/McpSection.tsx` (subscribe → status dots, per-server error line, Reconnect link); modify `src/ui/App.tsx` or `Chat.tsx` mount (call `getMcpManager().refresh(settings)` on load and on settings save).

- [ ] Wire → typecheck → manual smoke via build → commit `feat(mcp): live connection status in settings`.

### Task 6: Content mapper (`src/mcp/content.ts` + tests)

**Files:** Create `src/mcp/content.ts`, `src/mcp/content.test.ts`.

**Produces:**
- `interface McpArtifactInput { kind: 'image'|'audio'|'video'|'html'|'blob'|'text'; mimeType: string; dataUrl?: string; text?: string; title: string }`
- `mapCallResult(result: { content?: unknown[]; structuredContent?: unknown; isError?: boolean }, ctx: { server: string; tool: string; maxChars?: number }): { modelValue: Record<string, unknown>; images: { dataUrl: string; caption: string }[]; artifacts: McpArtifactInput[] }`
- text parts → concatenated into `modelValue.text` under budget (default 16_000 chars, truncation note); `structuredContent` → `modelValue.structured` (JSON, budgeted); image content (`{type:'image', data: base64, mimeType}`) → dataUrl + caption `Image returned by <server>.<tool> — a plain image, no numbered boxes.` + artifact; audio content → artifact only + model note; embedded resource text → folded into text budget; embedded resource blob → artifact by mime sniff (audio/* → audio, video/* → video, text/html → html, else blob); `isError` → `modelValue.error`.

Tests: text concat + truncation, structured passthrough, image→queue+artifact+note, audio artifact + note, resource text/blob variants, isError, empty content.

- [ ] TDD cycle → commit `feat(mcp): pure rich-content mapper`.

### Task 7: Artifact store (`src/data/mcpArtifacts.ts`)

**Files:** Create `src/data/mcpArtifacts.ts` (clone screenshots.ts shape: DB `lychee-mcp`, store `artifacts`, keyPath `id`, prune 50MB/30d, `conversationId` linkage); modify `src/ui/settings/DataTab.tsx` + `src/data/usage.ts` consumers only if a usage list exists to extend (add row); modify `src/ui/Chat.tsx` conversation-delete path where `deleteShotsForConversation` is called → also `deleteMcpArtifactsForConversation`.

**Produces:** `saveMcpArtifact(a: McpArtifactInput & { conversationId: string; server: string; tool: string }): Promise<string>`, `getMcpArtifact(id)`, `deleteMcpArtifactsForConversation(id)`, `clearMcpArtifacts()`, `mcpArtifactsUsage()`.

- [ ] Implement → typecheck → commit `feat(mcp): IndexedDB artifact store for rich MCP content`.

### Task 8: MCP dynamic tools + chat wiring + cards

**Files:** Create `src/mcp/tools.ts`; modify `src/ui/Chat.tsx` (merge into `createAgentTools(...)` spread at line ~1741: `tools: { ...createAgentTools(...), ...buildMcpTools(...) }`; ToolPill branch rendering `McpContentCard` for outputs with `artifactIds`; system-prompt capabilities note mentions connected MCP servers); create `src/ui/McpContentCard.tsx` (image/audio/video/html render from store; html via sandboxed iframe srcdoc? NO scripts — static HTML via `DOMPurify` sanitize + `dangerouslySetInnerHTML` inside a bounded card; interactive HTML waits for MCP Apps task).

**Produces:** `buildMcpTools(opts: { manager: McpManager; settings: Settings; requestApproval: ApprovalGate; imageQueue: QueuedImage[]; conversationId: string; visionCapable: boolean }): ToolSet`
- One `dynamicTool({ description, inputSchema: jsonSchema(tool.inputSchema), execute })` per cataloged tool of enabled, non-`never` servers; policy `never` (tool or server) skips; `ask` → `requestApproval({ toolName, summary: 'Call <tool> on <server> (MCP)', reason: from args._reason? no — use description })`; `always` skips card.
- execute: `manager.callTool(server, tool, args, { signal, timeoutMs: 60_000 })`, one `ensureConnected` retry on connection error, map via `mapCallResult`, save artifacts, push images to queue (only when visionCapable; else artifact-only with note), return `{ ...modelValue, artifactIds }`.
- description prefix `[MCP · <server>] ` so ToolSearch surfaces provenance.

- [ ] Implement + wire + card → typecheck + test → build → commit `feat(mcp): MCP tools ride disclosure + approval; rich content cards`.

### Task 9: Permissions rows

**Files:** Modify `src/ui/settings/PermissionsTab.tsx` (new "MCP servers" accordion under Tool permissions: one group per configured server, seg control bound to `policies[server].default ?? 'ask'`, expanded rows per cached tool bound to `policies[server].tools[tool]`); policy writes via `commit({ ...draft, mcp: { ...mcp, policies: … } })`.

- [ ] Implement → typecheck → commit `feat(mcp): per-server/per-tool permission rows`.

### Task 10: OAuth

**Files:** Create `src/mcp/auth.ts` (`ChromeOAuthProvider implements OAuthClientProvider`, storage keys `mcpAuth:<server>` holding `{ clientInformation?, tokens?, codeVerifier? }`; `clearAuth(server)`); modify `src/mcp/manager.ts` (pass `authProvider` to transports; catch `UnauthorizedError` → status `needs-auth`; `authorize(name)`: connect attempt → on redirect request run `chrome.identity.launchWebAuthFlow` from provider's `redirectToAuthorization` via a deferred — implement provider so `redirectToAuthorization` performs launchWebAuthFlow itself, extracts `code`, calls `transport.finishAuth(code)`, then manager reconnects); modify `public/manifest.json` (add `identity` permission); modify `src/ui/settings/McpSection.tsx` (Authorize button on `needs-auth`, Sign out link clearing tokens); modify `src/ui/Chat.tsx` ToolPill (error text containing `needs authorization` renders an Authorize button calling `getMcpManager().authorize(server)`).

- [ ] Implement → typecheck → build → commit `feat(mcp): OAuth via chrome.identity (discovery, DCR, PKCE, refresh)`.

### Task 11: Resource tools

**Files:** Modify `src/tools/tools.ts` (add `ListMcpResources`, `ReadMcpResource` importing `getMcpManager`; gate via requestApproval; ReadMcpResource maps content through `mapCallResult`-adjacent resource mapping — reuse content.ts via a `mapResourceResult` export added in Task 6 file with tests); modify `src/data/settings.ts` (`TOOL_CATALOG` entries group `'mcp'`, `ListMcpResources` defaultPolicy `'always'`; `GROUP_ORDER` + `GROUP_LABELS` add `mcp: 'MCP'`); type `ToolGroup` add `'mcp'`.

- [ ] Implement (+ mapResourceResult tests) → typecheck/test → commit `feat(mcp): resource listing/reading tools`.

### Task 12: Prompts in slash menu

**Files:** Modify `src/ui/Chat.tsx`: `SlashCandidate` add `{ kind: 'mcp-prompt'; server: string; name: string; description: string; args: { name: string; required?: boolean; description?: string }[] }`; `refreshSlashCandidates` folds in `getMcpManager().runtime()` prompts; `selectSlash` for mcp-prompt with required args opens inline `McpPromptForm` (small overlay collecting arg values) else immediately runs; on submit: `getPrompt` → flatten returned messages' text into the composer draft (user reviews, then sends) — injection-as-draft keeps the user in control and reuses the ordinary send path.

- [ ] Implement → typecheck → build → commit `feat(mcp): server prompts as slash commands`.

### Task 13: App bridge (pure) (`src/mcp/appBridge.ts` + tests)

**Files:** Create `src/mcp/appBridge.ts`, `src/mcp/appBridge.test.ts`.

**Produces:** the host side of the MCP Apps postMessage JSON-RPC protocol, transport-agnostic:
- `interface AppBridgeHost { callTool(name: string, args: unknown): Promise<unknown>; openLink(url: string): void; onSizeChange(h: number): void; getContext(): { toolResult: unknown; theme: 'light'|'dark' } }`
- `handleAppMessage(msg: unknown, host: AppBridgeHost): Promise<unknown | null>` — validates JSON-RPC envelope, routes `ui/initialize`, `tools/call`, `ui/open-link`, `ui/size-changed` notifications; unknown method → JSON-RPC error; malformed → null. Tool calls restricted to host-provided callTool (already server-scoped).

Tests: initialize returns context, tools/call routes + result envelope, error envelope on throw, size notification, malformed/unknown ignored/error.

- [ ] TDD → commit `feat(mcp): pure MCP Apps bridge protocol`.

### Task 14: Sandbox page + McpAppCard

**Files:** Create `sandbox.html` + `src/sandbox/sandbox.ts` (nested-iframe host: receives `{html, context}` from parent via postMessage, srcdoc's it into inner iframe with `allow-scripts`, relays JSON-RPC both ways); modify `vite.config.ts` (input `sandbox: 'sandbox.html'`); modify `public/manifest.json` (`"sandbox": { "pages": ["sandbox.html"] }`); create `src/ui/McpAppCard.tsx` (iframe of `sandbox.html`, wires `handleAppMessage` with a host whose callTool goes through the SAME policy+requestApproval path via a callback prop from Chat, height from size events, external-URL variant direct iframe + fallback link); modify `src/mcp/tools.ts` (detect tool meta output-template `ui://` resource → after call, `readResource` the template, save html artifact, return `appArtifactId`); modify `src/ui/Chat.tsx` ToolPill → renders `McpAppCard` when `appArtifactId` present.

- [ ] Implement → typecheck → build → commit `feat(mcp): MCP Apps in sandboxed iframes`.

### Task 15: Docs + verification

**Files:** Modify `CLAUDE.md` (MCP invariant bullet: panel-resident manager, config-is-the-JSON, tools ride disclosure+gate, image invariant via content mapper, sandbox-page apps, OAuth popups user-initiated only); `README.md` feature mention.

- [ ] `npm test` + `npm run typecheck` + `npm run build` all green → commit `docs(mcp): architecture notes`.
