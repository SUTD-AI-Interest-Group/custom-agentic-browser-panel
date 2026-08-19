# MCP Servers and Apps

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
