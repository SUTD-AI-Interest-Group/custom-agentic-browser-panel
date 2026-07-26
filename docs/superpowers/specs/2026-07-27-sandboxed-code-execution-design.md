# Sandboxed code execution + artifacts — design

Date: 2026-07-27
Status: approved (approach and architecture approved in-session)

## Goal

Give the Lychee agent a sandboxed environment to *create and work on things*:

1. **A code-interpreter tool** (`RunCode`): the agent runs short JS snippets mid-turn —
   calculations, data transforms, chart prep — and the results feed back into the chat.
2. **Artifacts-style creation**: the agent writes small self-contained web pages /
   visualizations / documents the user can view and interact with in the panel.

JS/TS first; Python (Pyodide) is a later, lazy-loaded add-on. A full dev environment
(npm, terminal, dev server) is explicitly out of scope.

## Research conclusions (July 2026)

- **WebContainers: permanently infeasible here.** Requires SharedArrayBuffer +
  cross-origin isolation *and* a per-preview-origin service worker; an MV3 extension has
  one origin whose SW slot the background worker owns, and Chrome documents cross-origin
  isolation as incomplete for extension worker contexts. The engine is closed-source,
  boots from StackBlitz CDNs (Chrome Web Store's remotely-hosted-code policy forbids
  that in privileged contexts), and needs a commercial license.
- **Nodebox: rejected.** No-SAB design would fit, but it is under CodeSandbox's
  "Sustainable Use License" (non-commercial only, verified directly) and effectively
  unmaintained (v0.1.9, ~2 years stale).
- **Locally-bundled WASM interpreters are the clean path.** quickjs-emscripten
  (~0.5–1 MB, MIT, real memory caps + interrupt handler for hard timeouts) for JS.
  Pyodide now runs on Chrome under `wasm-unsafe-eval` alone and is self-hostable —
  viable later. esbuild-wasm for TSX/multi-file bundling later. None need
  SharedArrayBuffer. Real Web Store extensions (Python Playground, Web Maker) ship this
  way today.
- **MV3 CSP facts:** `extension_pages` CSP may add `'wasm-unsafe-eval'` but never
  `'unsafe-eval'`. Manifest-sandboxed pages default to a CSP with `'unsafe-eval'` +
  `'unsafe-inline'` and are the Web-Store-sanctioned place to run eval-style code.
  A sandboxed page has an *opaque origin*: module scripts and CORS-mode fetches against
  `chrome-extension://` fail; classic scripts load fine.
- **Convergent prior art** (Claude Artifacts, bolt.diy): execute in a sealed, stateless
  sandbox; persist *outside* it. Anthropic's "an artifact is a capture of work, not an
  application" is the target shape — it matches Lychee's no-backend, every-tool-gated
  posture.
- **Watch-list, not dependencies:** BrowserPod (commercial hosted agent sandbox,
  launched Feb 2026); WASIX/wasmer-js (hard SAB requirement).

## Approach (chosen: A — sealed sandbox, staged)

### Architecture

A second manifest-sandboxed page, `public/sandbox-exec.html`, added to the manifest's
`sandbox.pages` beside `sandbox.html`. Same shape as its sibling — a dumb page with one
inline classic script — but a tighter trust profile: a
`<meta http-equiv="Content-Security-Policy">` adds `connect-src 'none'` on top of the
sandbox defaults (meta CSP only tightens, and does not affect `sandbox.html`, whose MCP
apps may need network).

The side panel mounts it as a hidden iframe, lazily on first use, and talks to it over
postMessage with requestId-correlated round-trips (the `appBridge.ts` /
`offscreen.ts:roundTrip` shape).

**Asset delivery — the sandbox never fetches.** The panel (privileged, same-origin)
fetches the bundled engine assets and transfers them into the sandbox via postMessage:
the QuickJS `.wasm` as a transferred ArrayBuffer, instantiated inside the sandbox under
its `unsafe-eval` CSP (emscripten `wasmBinary` option). The engine *script* loads as a
classic `<script src>` in `sandbox-exec.html` (classic scripts skip CORS), built as a
self-contained IIFE by a second small Vite config. This same delivery path later serves
esbuild-wasm and Pyodide; the sandbox page stays a dumb loader forever.

### Security invariants (extending Lychee's existing ones)

- Untrusted (AI-written) code executes **only** inside `sandbox-exec.html`: opaque
  origin, no `chrome.*`, no network (`connect-src 'none'`), no storage, no host DOM.
  QuickJS memory cap + interrupt-handler timeout are the inner wall; the sandbox page is
  the outer wall, so an interpreter escape is contained.
- `RunCode` and the artifact tools gate on `requestApproval` like every other tool; the
  approval card shows the (truncated) code as its summary.
- Only serializable data crosses the bridge. Results follow the id-only artifact
  invariant: big outputs go to IndexedDB, never into model history.
- Everything ships in the extension package — no CDN at runtime.

### Components

- `public/sandbox-exec.html` — sealed host page (inline relay + classic script tag,
  meta-CSP).
- `src/exec/protocol.ts` — pure message protocol (init/run/render, result/error,
  output budgets). Unit-tested.
- `src/exec/engine.ts` — QuickJS wrapper: fresh context per run, console shim,
  memory/stack limits, deadline-based interrupt handler, promise-job draining,
  serialization of the completion value. Runs under vitest in Node (quickjs-emscripten
  is isomorphic), so it is directly unit-testable.
- `src/exec/runtime.ts` — sandbox-side entry (IIFE build): receives init (wasm bytes) /
  run messages, calls the engine, posts results.
- `src/exec/host.ts` — panel-resident manager (`McpManager` analog): iframe lifecycle,
  asset fetch + transfer, round-trips, timeouts, teardown/recreate on crash.
- `src/tools/tools.ts` — `RunCode` entry in `createAgentTools()` (auto-discovered by
  the toolDiscovery catalog, gated). Stage 2 adds `CreateArtifact` / `UpdateArtifact`.
- Stage 2: `src/data/artifacts.ts` — IndexedDB store mirroring `mcpArtifacts.ts`
  (id-keyed, byte+age pruning, usage reporting); `src/ui/ArtifactCard.tsx` — renders a
  preview by mounting the sealed sandbox in render mode; a `Rerun`/open-full-view
  affordance.

### Data flow

**RunCode:** model calls `RunCode({code, reason})` → approval card (code shown) →
`host.ts` ensures the sandbox iframe is initialized (fetch + transfer assets once) →
`run` round-trip with code → engine executes with limits → `{value, logs, error?}`
posted back → tool returns a *budgeted* text result to the model (console output +
completion value, truncated like `content.ts` does at 16k chars); oversized output is
stored and referenced by id.

**Artifacts:** model calls `CreateArtifact({title, html, reason})` (self-contained
HTML/CSS/JS document, v1) → approval → saved to `lychee-artifacts` IndexedDB → tool
returns `{artifactId, title}` only → `Chat.tsx`'s tool renderer maps the id to
`ArtifactCard`, which reads the record and mounts the sealed sandbox with a `render`
message (nested `srcdoc` iframe, `sandbox="allow-scripts"`, never
`allow-same-origin` — the `sandbox.html` app-mount pattern). `UpdateArtifact` replaces
content by id and bumps a revision so open cards re-render.

### Error handling

- Timeout: engine interrupt fires on deadline → structured `{error: 'timeout'}`;
  the tool result tells the model how long it ran and suggests smaller steps.
- OOM/crash: QuickJS memory cap raises; a wedged/dead iframe is detected by the host
  round-trip timeout → iframe torn down and recreated on next use; the run fails with a
  clear error rather than hanging the turn.
- Approval denial returns the standard `DENIED` shape.
- Serialization: completion values are JSON-serialized inside the sandbox with cycle
  handling; unserializable values degrade to their string form.
- All budgets (log lines, value size, artifact size) enforced in pure code with tests.

### Testing

- Pure/unit (vitest): `protocol.ts` codec + budgets; `engine.ts` real QuickJS runs in
  Node — success, console capture, timeout via interrupt, memory cap, promise draining,
  serialization edge cases; `artifacts.ts` prune logic (pure part).
- The repair-hook/disclosure invariants already covered by `agent.test.ts` apply
  automatically (new tools enter via `createAgentTools`).
- End-to-end: `npm run build`, reload unpacked extension, exercise RunCode and an
  artifact in the panel (`/verify-extension` flow).

### Staging

1. **Stage 1 (this work):** sealed sandbox host + `RunCode` (JS only).
2. **Stage 2 (this work):** `lychee-artifacts` store + `CreateArtifact`/`UpdateArtifact`
   + `ArtifactCard` preview, v1 = single-file self-contained HTML (no bundler; CDN
   scripts are blocked by the sandbox CSP and the tool description says so).
3. **Stage 2b (later):** esbuild-wasm in the transfer pipeline → TSX/React/multi-file
   artifacts with vendored libs.
4. **Stage 3 (later):** Pyodide lazy-loaded into the sandbox for `RunCode`
   language:'python'; optional ZenFS-over-IndexedDB workspace if a real project
   filesystem is ever wanted.
