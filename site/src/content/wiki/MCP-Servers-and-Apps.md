# MCP Servers and Apps

**October–November 2026 follow-up:** modern transport/OAuth, opt-in update
subscriptions, interactive clarification, durable server tasks and verified
remote skills have since merged into `main`. The separate November optimisation
branch adds task-alarm and background-client cleanup. See
[November 2026 Update](November-2026-Update) for the integration boundaries and
[Background Work and Cleanup](Background-Work-and-Cleanup) for resource ownership.
The original integration story follows.

**Goal.** Let users plug any Model Context Protocol server into the panel — the
standard `mcpServers` JSON they already have, OAuth and all — and give the agent
the **full protocol surface**: tools, resources, prompts, rich media results,
and interactive MCP Apps rendered live in the chat. Entirely client-side, like
everything else here.

Spec: [`2026-07-24-mcp-support-design.md`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/docs/superpowers/specs/2026-07-24-mcp-support-design.md) ·
Plan: [`2026-07-24-mcp-support.md`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/docs/superpowers/plans/2026-07-24-mcp-support.md)

---

## The config IS the file

The founding decision (`4737def`): `Settings.mcp.servers` is **byte-for-byte the
standard `mcpServers` object** — the same shape Claude Desktop, Cursor and VS
Code write. Import, the in-place JSON editor, and one-click copy are therefore
pure serialization; there is no translation layer to drift out of sync with the
ecosystem's format.

Everything the file must *not* contain rides sidecars: enabled flags and
per-server policies in separate maps, OAuth tokens under their own
`mcpAuth:<server>` storage keys. A copied config **cannot** leak credentials,
because the credentials were never in it.

`stdio` entries (the `"command": "npx …"` kind) round-trip untouched but render
greyed-out — a browser cannot spawn processes, and pretending otherwise helps
nobody. The row says so and points at a local HTTP bridge instead.

A stdio server's `env` map is a different case from OAuth tokens: it
legitimately belongs *in* the file — that's what `env` is for in the standard
shape — so it can't be sidecar'd out. Until `21eec68` it was also the one
secret surface the vault never swept (provider `apiKey`s, Langfuse keys, MCP
`headers` were already sealed). It's sealed at rest now too, and uniformly —
every value, not just names that pattern-match a sensitivity heuristic, since
a heuristic is guessable and one miss (a token in a var called `AUTH` or
`CREDS`) is the exact plaintext-credential failure this closes. In-memory
settings stay plaintext, so Settings → Copy JSON still emits a usable config
with real values, no `lysec1.` ciphertext.

## Riding the existing machinery instead of building new machinery

The whole tool integration is one parameter. MCP tools become AI-SDK dynamic
tools and enter the turn **through `createAgentTools`' new `extraTools`
parameter** (`23d4b98`) — *not* spread into the ToolSet by the caller, and the
distinction is load-bearing. The disclosure catalog is derived from that
ToolSet; a tool merged outside it could never be listed by `ToolSearch`, loaded
by `GetTool`, or rescued by the
[unloaded-call repair hook](Progressive-Tool-Disclosure#and-then-it-broke-the-security-model).
Merging at the right seam bought disclosure, repair, per-call approval cards,
and Langfuse spans for free — a 40-tool server costs zero schema tokens until
the model actually loads one of its tools.

Policies are two-level (per-tool override → server default → `ask`), the same
resolution pattern the provider/model reasoning dial uses, with rows in
Settings → Permissions (`afa4584`). `never` at either level means the tool is
**not built at all** — absent beats denied, as always.

Rich results go through a pure, tested mapper (`767cc5f`) that enforces the
[image invariant](Agent-Perception) for a protocol we don't control: text to the
model under an explicit truncation budget, images through `imageQueue` with
captions (a blind model gets a note instead — it must never wait for a picture
that isn't coming), and audio/video/HTML/binary into an IndexedDB artifact store
(`fdee5ee`) rendered as cards, prunable from the Data tab. Server prompts join
the composer's `/` menu as `/mcp:server:prompt`, and a prompt's fetched text
lands **as a composer draft the user reviews** — never auto-sent (`a066b72`).

The catalog cache paid for the "zero schema tokens until loaded" trick with
O(servers) writes on the way back: `persistCatalogCache()` re-serializes and
stores *every* connected server's catalog on *any one* server's change, since
a single `mcpCatalog` storage key holds the whole map with no partial update.
A `refresh()` reconnecting several servers at once, or a chatty `listChanged`
stream from one server, paid one full write per server instead of one for the
batch. `469e6e0` coalesces writes behind a 250ms debounce — still a display
cache, never the source of truth for a live connection's own catalog.

## OAuth without a backend

The SDK's `OAuthClientProvider` interface meant we wrote none of the OAuth 2.1
choreography ourselves — discovery, dynamic client registration, PKCE, refresh
all come from the SDK; our `ChromeOAuthProvider` (`95809fb`) supplies the
Chrome-shaped parts: `chrome.identity.launchWebAuthFlow` as the user agent and
`chrome.storage.local` as the token store.

One rule was designed in from the start and later saved us: **an auth popup may
only ever launch from an explicit user click.** A background reconnect gets a
non-interactive provider whose `redirectToAuthorization` refuses, parking the
server at *needs auth* until the user presses Authorize. A browser extension
that pops OAuth windows uninvited is indistinguishable from malware.

A second rule had to be *added*, not designed in: a token is only ever valid
for the URL it was issued for, but storage was keyed solely by the server's
mutable display name (`mcpAuth:<name>`) and never purged. Since the SDK
attaches `Authorization: Bearer <token>` before any handshake or audience
check, editing an entry's `url` — or importing a shared `mcpServers.json`
that happens to reuse a familiar name — silently replayed a live token as the
*very first request* to a different host. `a701255` stamps every stored
record with the `boundUrl` it was issued for; every read refuses and
self-evicts on a mismatch, including a record written before the fix that
carries no `boundUrl` at all — so there's no migration pass, and no window
where an install stays exposed just because it predates the patch.
`manager.ts` additionally purges auth on removal and on a URL edit, so
"remove a server, re-add the same name" is a clean slate rather than an
inherited credential.

## MCP Apps: running someone else's HTML in your extension

MV3 extension pages forbid inline scripts, so app HTML runs in a
**manifest-sandboxed page** — unique origin, no `chrome.*`, the one place
Chrome permits app-supplied scripts (`e744dcb`). The sandbox page is a dumb
relay; every protocol decision lives in a pure, tested bridge in the panel, and
an app's `tools/call` re-enters **the same policy + approval gate as the
agent's own calls, scoped to the app's producing server**. An app can render
whatever it likes; it cannot reach another server's tools, and it cannot speak
as the user (`ui/message` text becomes a composer draft).

Not every app goes through that relay. A `text/uri-list` template — a plain
external `https://` URL instead of returned HTML — skips the sandboxed page
entirely: `McpAppCard.tsx` iframes it directly in the panel's own React tree,
with a plain "Open in a tab" link for sites that refuse framing. It has its
own, separate containment story, below.

Four platform landmines shaped the sandbox — two from the start, two found
later by a security review:

- **Module scripts don't load in sandboxed pages.** A sandboxed page has an
  opaque origin, so fetching a module from `chrome-extension://` fails CORS.
  The host script is deliberately an *inline classic script* in
  `public/sandbox.html`, shipped verbatim outside the Vite build.
- **The nested app iframe gets `allow-scripts` and never `allow-same-origin`** —
  the app runs, and stays in an origin of its own.
- **`sandbox.html` itself carried no CSP at all, for the whole life of the
  feature, until `23563b6`.** `manifest.json` declares the page as sandboxed
  but sets no `content_security_policy.sandbox` override, so absent an
  explicit meta tag it ran under Chrome's permissive MV3 default — which pins
  only `script-src`/`child-src` and leaves `connect-src`/`img-src`
  unrestricted, unlike an explicit `default-src`. Verified against a real
  Chromium instance with a local HTTP listener as ground truth: an app's
  `fetch`, `XMLHttpRequest`, and `<img src>` all reached the listener as
  genuine requests, no CSP violation logged. Only form submission was
  incidentally blocked — by `child-src`'s framing restriction, not
  `form-action`. The impact is bounded and worth stating precisely: an app
  only ever sees its own server's `toolInput`/`toolResult`, which that server
  already has, so this was a tracking/fingerprinting surface, not an
  exfiltration path — but it contradicted the artifact sandbox's advertised
  default-deny (see [Security and the Permission
  Model](Security-and-the-Permission-Model)). Now `default-src 'none'` with
  `script-src 'unsafe-inline'` (no `'self'` — the relay is inline-only by
  design). A full `ui/initialize` round trip was re-run afterward to confirm
  apps still render under the tightened policy.
- **The external-URL card's own iframe carried `allow-same-origin`,
  contradicting the rule stated right above it** (`c2edc53`). A
  `text/uri-list` app's URL is entirely server-chosen, so granting it the
  real panel origin's cookies and storage was never a path *into* the panel —
  cross-origin SOP still applies, the framed origin can never be
  `chrome-extension://`, and there's no `allow-top-navigation` — but it was
  full-capability embedded browsing of a server-chosen page (its cookies,
  its storage, its credentialed requests) with nothing telling the user this
  card behaves differently from a sandboxed `ui://` app. Removed;
  `allow-popups` stays, so a page that genuinely needs a real login still
  works via a normal top-level window, or the "Open in a tab" fallback next
  to the card.

## What broke, in order

This feature has the project's usual honest tail — five distinct failures after
it "worked", three of them only findable against a real server (Higgsfield's
remote MCP, whose generation widget polls its own job status):

1. **The disable-mid-connect race** (`40c3b86`, found in pre-merge review). A
   slow handshake couldn't be cancelled, so disabling a server mid-connect let
   the connect *complete anyway* and silently install a live connection to a
   server the UI showed as Disabled — which the model could then call. Fix: a
   teardown generation counter; a connect that finishes under a stale
   generation closes what it opened and walks away.
2. **The stale JSON-editor save** (`40c3b86`). Save replaces the whole server
   map, so an editor left dirty while another control changed the list would
   silently resurrect a removed server. Save now refuses when the base changed
   under the edit.
3. **Ajv vs MV3** (`de80b5a`). The MCP SDK's default JSON-Schema validator is
   Ajv, which *compiles schemas with `new Function`*. MV3's CSP bans eval,
   unconditionally — so the first `listTools()` killed the connection with
   `"Evaluating a string as JavaScript violates…"`. The SDK ships an
   interpreter-based validator for eval-banned runtimes; every client now uses
   it. Your dependency's code generation is your CSP violation.
4. **The OAuth popup inside a request timer** (`de80b5a`). Our first authorize
   flow let the transport trigger auth from *inside* the `initialize` request —
   so the request's 60-second timeout kept ticking while the user logged in,
   and slow logins died with `MCP error -32001` **even when the user approved**.
   The SDK's `auth()` orchestrator runs the same flow with no request in
   flight. Never run interactive UX on a network timeout's clock.
5. **The hand-rolled handshake** (`4444b07`). The first bridge implemented
   `ui/initialize` from memory of the MCP Apps announcement. Real apps validate
   the result with zod — and rendered their validation error *as the app*:
   `expected string, path: ["protocolVersion"]…`. The app itself was telling us
   the spec. We fetched the actual ext-apps `2026-01-26` specification and
   rebuilt the bridge to it: the proper
   `protocolVersion / hostInfo / hostCapabilities / hostContext` handshake,
   then `initialized → tool-input / tool-result` notifications — which is
   exactly the lifecycle a start-a-job-then-poll widget needs.

There was also a phantom sixth: the CSP error "recurring" after the fix. It
hadn't — bundle archaeology (one `new Function` in the whole build, unreachable;
the validator option present in the minified output) proved the panel was simply
still running the pre-fix code. **A rebuilt `dist/` is not a reloaded
extension.** The version got bumped to 0.2.0 mostly so a human can tell which
build they're arguing with.

## The lesson we'd pass on

Don't implement a protocol from memory when the counterparty ships a validator.
The zod error in that widget was the most precise spec document we ever
received — but we only got it because we'd already built everything else
correctly enough for a real third-party app to boot, object, and tell us
exactly which four fields it wanted.

## November branch: asynchronous MCP tasks

The sections below were previously recorded only in the website's copy of this
wiki. They describe the implementation in the November snapshot
[`9180e33`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/commit/9180e33bb35e1cf688a8861443307aacbe6e7b8d).
That snapshot originally preceded integration of the October MCP changes. The
11 November merge now preserves both protocol paths with separate migrated task
stores and shared erasure; the sections below retain the SDK protocol details.
For the October modern-protocol implementation, use the [integration record](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/bb027218be5b0be384232f4d99b44fc86fff2afb/docs/development-handoff.md)
for the merged transport, clarification, task and skill flows.

Tools declaring `execution.taskSupport: "required"` or `"optional"` use task
execution when the server advertises `tasks.requests.tools.call`. The initial
call returns a task handle immediately, freeing Lychee to do other work. A
companion tool, normally named `mcp_<server>_<tool>_task`, accepts `taskId` and
an `action` of `status`, `result`, or `cancel`. It follows the producing tool's
permission policy and approval gate. An unfinished `result` request returns
status immediately; final results use the same text, media, and app-card
pipeline as ordinary tool results. Status responses include the server's
`pollInterval`; the agent is instructed to respect it between checks.

Handles belong to the initiating conversation and server configuration. Task IDs,
arguments, protocol/session identity and completed results are stored in IndexedDB.
A service-worker alarm checks pending tasks roughly once per minute while Chrome
is running, respecting longer server poll intervals. The cleanup pass disarms
that alarm when the queue is empty and closes each polling client in `finally`. It retries transient errors
without resubmitting the original job, and queues final outcomes while the panel
is closed. Results already retrieved are retained locally even if the server later
expires the task.

When the corresponding chat is visible and idle, Lychee receives an automatic
completion message, retrieves the result through the task companion tool, and
continues the original request. If the chat was interrupted, its saved checkpoint
is restored first. Follow-up calls retain ordinary approval requirements; this automatic MCP
completion flow does not start a model continuation while the panel is closed. Completion delivery is leased across
panels and acknowledged after the continued conversation is saved. An interrupted
delivery can be retried after its one-minute lease expires.

Stop suppresses automatic continuation for outstanding tasks in that chat; it does
not cancel remote work. Use the task tool's `cancel` action to request remote
cancellation. Deleting a chat removes its tracked tasks. Disabled servers and tools
are not polled or automatically resumed, and changing server configuration
invalidates old handles. Browser shutdown pauses polling; reopening Chrome resumes
it, subject to the server retaining the task/session. `input_required` is surfaced
as a status in this snapshot; its task flow does not include sampling or the
interactive elicitation support merged into `main`.

This implements the installed SDK's [2025-11-25 task protocol](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks),
including `tasks/get`, `tasks/result`, and `tasks/cancel`. The newer separate
Tasks extension and its `tasks/update` API are not implemented.

Validation: `npm run build`, focused Vitest suites for MCP tasks, background polling,
conversation deletion and recovery, and `node scripts/test-mcp-tasks-browser.mjs`
(with `CHROME_BIN` when needed). The browser test uses local MCP and model fixtures,
closes the creating context, completes the job in the service worker, opens the
production chat and verifies automatic continuation and no duplicate on reopening.

## November branch: app interoperability

The client advertises `io.modelcontextprotocol/ui` with
`text/html;profile=mcp-app`. App-only tools (`_meta.ui.visibility` excluding
`model`) stay out of model discovery but remain available through the
approval-gated app bridge. Full producing results, including app-only `_meta`,
are kept in the artifact store and delivered to the widget without exposing
that metadata to model history. Standard array-shaped `ui/message` content
becomes a composer draft. Unsupported model-context updates return an explicit
error, and the handshake reports the supported `2026-01-26` revision.

App-originated calls to task-capable tools wait through SDK polling and return
the final MCP result to the widget. Apps remain inline, with the existing
network-restricted sandbox; external scripts and server-declared CSP domain
allowlists are not supported.
