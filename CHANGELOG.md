# Changelog

All notable changes to **Lychee AI** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Lychee AI is
pre-1.0. Most sections below are grouped by **development milestone (date)** rather than by
released version — each date is a distinct burst of work on `main` — with a **version heading**
marking each Chrome Web Store release and naming the milestones it shipped. Short commit hashes
are given in parentheses so any entry can be traced back to its change.

This log covers **12 July 2026 onward**. The project's first two days (10–11 July 2026) — the
initial side-panel, onboarding, model settings, memory/dreaming, `@mentions`, page control,
the approval gate, and the `AutofillForm`/`profile`-memory groundwork — predate this window and
are not itemised here; see the [wiki Engineering Log](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/wiki)
for that history.

---

## [0.4.0] — 2026-08-20 — *Chrome Web Store update*

The third store release, and the first whose headline is durability rather than reach. A turn
can now be *seen* (token counts, cost, an optional local step trace), *survived* (a long chat
folds instead of dying on a context-length rejection; a turn interrupted by closing the panel
can be resumed), and *taken back* (page control keeps a list of what it changed and offers
undo). Alongside that, the composer accepts office documents, memory consolidation moved
somewhere it can actually finish, and a second whole-codebase adversarial audit closed four
criticals — including a shipped feature, `RunCode`, that had never once run in a real browser.

**No permission changes.** `public/manifest.json` differs from the published `0.3.0` in the
version string and nothing else, so existing installs update without being disabled for a
re-grant.

**One disclosure caught up with the code.** Office-document attachments shipped on 2026-08-08
and were not reflected in `PRIVACY.md` or the store listing's data-use table, both of which
still said "images, PDFs, and text files". Corrected in this release, along with the composer's
own file picker, whose `accept` filter had never listed the office formats — dragging a `.docx`
in worked, but the **+** button's dialog hid it.

Contents: the four milestones below dated 2026-08-08, 2026-08-09, 2026-08-10 and 2026-08-11, in
full.

---

## [2026-08-11] — Turns you can see, survive, and take back

Five features around one theme: a turn should be legible, survivable, and reversible.
Design: `docs/superpowers/specs/2026-08-10-turn-observability-and-durability-design.md`.

Every feature was driven in real Chromium against a local LM Studio model behind a logging
proxy, not just unit-tested — which is how three of the four defects below were found at all.

### Added

- **Token counts and cost, finally surfaced** — `toModelUsage`/`sumUsage` had been carefully
  plumbed and `UIMessage.usage` populated for months, and *nothing rendered it*. Each reply now
  carries a `1.2k → 340` chip and the chat a running total; per-model rates in Settings →
  Providers turn that into a real figure. Rates are user-entered rather than bundled: a
  model-agnostic client cannot ship prices that stay true, and a confidently wrong cost is worse
  than none. `estimateCost` subtracts cached tokens from the input total rather than adding them
  (every provider that reports both counts cached *inside* input — billing both is an ~11x
  overstatement on a cached prompt) and never bills `reasoningTokens`, which is a breakdown of
  output, not an addition to it.
- **Context compaction** — a long chat used to die on a `context_length_exceeded` 400, which
  `classifyError` correctly calls *permanent*, so the turn ended with no recovery and the only
  way forward was a new chat. Older turns now fold into a summary at ~75% of the window,
  measured from the provider's **reported** input tokens. Two invariants are structural: the cut
  only ever lands before a `user` message, and the replacement is always a user+assistant pair,
  so a tool call is never split from its result and no two same-role messages ever end up
  adjacent. The reactive backstop (`isContextOverflow`) sits *beside* `classifyError` rather
  than inside it — research has no compaction path and must keep treating that 400 as permanent,
  or it retries an impossible request to its 24h deadline.
- **Turn durability** — the transcript persisted only *after* a turn finished, so closing the
  panel mid-answer lost the reply and the user's own message. Turns are checkpointed as they
  stream into a new `inflight` store, and reopening offers Resume / Discard. The checkpoint is
  deleted in the **same transaction** as the final save, so a finished turn can never leave a
  resume card behind. A resumed turn deliberately inherits no page-control grant: the tab has
  almost certainly navigated, so the origin fence is stale and it must ask again.
- **Local turn traces** (opt-in, Settings → General) — the step timeline, which tools
  progressive disclosure actually exposed at each step, when `repairToolCall` rewrote a call
  into `GetTool`, and tokens per step. Previously visible only through Langfuse, an
  off-by-default beta that ships content off-device; `RunCode` shipped broken precisely because
  nothing local showed what happened at runtime.
- **Page-control journal and undo** — a granted session could type into a dozen fields and left
  no record and no way back. A card now lists what changed and offers Undo last / Undo all. The
  record is split by *lifetime*: the rendered journal is redacted, while the raw prior values
  undo needs live only in memory on the session and die with it — so a password can be typed and
  undone without ever being written anywhere it could outlive the turn. Submits, navigations and
  sensitive fields are named as permanent rather than silently skipped.

### Fixed

- **The trace drawer rendered `NaN` for every token count** — found only by driving a real
  model. `redactSecrets`'s key rule matches the substring `token`, so running each step through
  it replaced `inputTokens`/`outputTokens` with `[redacted]`. Over-redaction is documented as
  acceptable in that function because it guards payloads that carry user data; a trace step does
  not — it holds numbers, tool names and a finish reason. The record is now protected by
  *exclusion* (tool inputs are never captured), which is the real mechanism, mutation-tested by
  adding `input` back and watching the secret test fail.
- **A reopened conversation ignored its own recorded token usage for one turn** — the
  compaction trigger read a ref that was never seeded on load, so a long chat restored from disk
  fell back to a character estimate on exactly the histories hardest to estimate.
- **`settingsLiveness.test.ts` guarded its property with a fixed 1500-character window** — which
  silently stopped covering the second of its two matches the moment anything was added above
  them. Re-anchored to the end of the cycle's `runAgentTurn` call.
- **`ALL_STORE_KEYS` in `storage.test.ts` drifted from the real union** — the runtime proxy for
  a compile-time guarantee, and the one place the compiler could not catch the new store. Caught
  by the test that exists to say so.

### Changed

- A mutation pass on the compaction planner showed its "always cuts before a user message" test
  could not fail: a perfectly alternating fixture cannot distinguish a correct cut from one
  shifted by two. Rewritten against an irregular history, and now caught by three tests instead
  of two.

---

## [2026-08-10] — Second adversarial audit: four criticals, and a feature that had never run

A nine-way audit of the whole codebase, then a fix wave in which every fix was re-reviewed by
someone who had not written it. That second pass mattered: **no fix survived review unchanged**,
two were sent back as "do not ship," and the reviews that found real defects were the ones that
*executed something* — a jsdom re-run of an extracted injected function, a constructed malicious
`.xlsx`, a Playwright session against real Chromium. The reviews that only read the diff found
nothing.

The audit's own severity ranking was wrong twice, both times downward: an item filed as
"duplicated constants, drift risk" turned out to have already drifted into a live gap, and an
item filed as "verify this CSP token" turned out to mean a shipped feature had never worked.

### Fixed

- **MCP OAuth tokens could be replayed to a different host** (`a701255`) — credentials were keyed
  by a server's mutable display name and never purged, while the SDK attaches
  `Authorization: Bearer` before any handshake or audience check. Editing an entry's `url`, or
  importing a shared `mcpServers.json` that reused a familiar name, sent a live token to a new
  host as its very first request. Records are now stamped with the URL they were issued for and
  refuse — and self-evict — on mismatch, which also covers configs repointed before this shipped.
- **Two SSRF holes in the unattended research browser** (`19412c7`) — `harvestImages` had no URL
  guard at all, and tab navigation validated only the *requested* URL, so a public page could 302
  to cloud metadata or a LAN service and have the landed page scraped into the notebook, then
  cited under the original safe-looking URL. Fixed structurally: the injected reader now returns
  `location.href` in the same synchronous execution as the content it extracts, so there is no
  window between checking and reading. The intermediate fix, which checked after navigating and
  then slept 900 ms to settle, was itself defeated by a page that redirected inside that sleep.
- **Sensitive-field detection was half-blind** (`3bdd228`) — the flag that forces a confirmation
  card for a payment or password field tested only `name` and `id`, so a React/MUI field labelled
  by `placeholder` or `aria-label` was never flagged and `AutofillForm` would type into it with no
  card at all. The pattern also required spaces between words, missing `account_number`,
  `sort_code` and `socialSecurityNumber`. Every label source now feeds the check, additively, so a
  hostile page's label can only add a detection and never suppress one.
- **A spreadsheet could exhaust memory at attach time** (`3c438fe`) — officeparser deep-copies a
  shared string once per referencing cell, and the existing limits bound inflated bytes, not cell
  count, so a sub-1 MB `.xlsx` could force multi-GB allocation on the panel's main thread before
  any approval gate. Bounded by the actual cost (cells × string size, since a cell cap alone is
  tradeable against it) and moved into a worker with a timeout. The first guard was bypassable
  with one unusual-but-legal zip path, because it re-derived an anchored path pattern where the
  library matches unanchored; selection is now by file *content*, so a part cannot hide behind its
  name.
- **`RunCode` had never worked in the browser** (`23563b6`) — `sandbox-exec.html`'s CSP was missing
  `wasm-unsafe-eval`, so QuickJS never instantiated: `exec:init` always failed and every call
  returned "engine not initialized". The whole test suite passed throughout, because tests drive
  the engine in Node where no CSP applies. Found only by driving the built extension in real
  Chromium. The MCP Apps sandbox page, which had no CSP at all and could reach the network, is now
  default-deny as well.
- **The committing-verb vocabulary had drifted between its two copies** (`e402af1`) — the
  unattended research policy never matched `place order` or `continue`, so those controls passed
  its only vocabulary check. A test named for that very parity had been passing the whole time,
  because it exercised one side of it. Both gates now share one list, converged on the stricter
  variant.
- **The foreground check ran before the approval card and never after** (`c2edc53`) — the card
  stays open as long as the user likes, so tabbing away and then clicking Allow fired the action
  against an unwatched tab; `AutofillForm` compounded it across a whole batch. Also dropped
  `allow-same-origin` from the iframe hosting an external-URL MCP app.
- **Attachments were frozen to the provider that was active when they were attached**
  (`371b2a1`) — attaching a PDF and then switching models mid-conversation broke every subsequent
  send, with no way to remove the attachment short of starting over. Stored attachments are now
  re-planned against the provider in use, both on load and at the start of each turn.
- **Research retried an impossible request for 24 hours** (`ede0fff`) — a model that cannot emit
  schema-conforming JSON produced a status-less error, which the classifier treated as transient,
  so each planning round backed off and retried to the task deadline instead of taking the
  fallback the code already had. Common on small local models.
- **MCP stdio `env` values were stored in plaintext** (`21eec68`) — the one secret surface the
  vault never swept. Sealed uniformly rather than by name heuristic.
- **Report images were never URL-screened at write time** (`469e6e0`) — an internal-network URL
  harvested from a page could end up embedded in the user's own report. Screened where images are
  recorded, which covers every render path at once.
- Smaller: a failed wasm fetch no longer surfaces as an opaque engine error (`469e6e0`); stranded
  research tasks are claimed under serialization so two ticks cannot dispatch the same task; the
  documented behaviour of the OpenAI-compatible adapter on PDF parts was corrected — it silently
  converts rather than throwing, so the failure lands as a remote 400 (`695b504`).

### Changed

- **Prompt caching on Anthropic** (`c549e07`) — the system prompt is split into a stable block
  carrying the cache marker and a volatile block after it, so the stable prefix is reused across
  conversations rather than only across steps within one turn. Tool order is pinned at the wire
  level, because the SDK renders tools in the full toolset's declaration order and a
  progressively-disclosed tool could otherwise appear *ahead* of an already-active one, which
  invalidates the prefix. A first version of this change was inert and would have cost money on
  short turns: one concatenated string becomes one cache block, and a marked block matches
  byte-for-byte, so reordering its contents achieved nothing.
- **Cache usage is now reported** (`c549e07`) — `cachedInputTokens` had been plumbed to Langfuse
  as `cache_read` and had never received data, because raw SDK usage was assigned into an
  all-optional type and the nested figures were dropped silently.
- **Pruning no longer reads what it is pruning** (`5e9d7a9`) — screenshots, MCP artifacts and code
  artifacts each re-read every full record (base64 images, whole HTML documents) on every save
  just to compute eviction. Each store now keeps a lightweight index written in the same
  transaction as the record.
- **Bounded DOM walks and batched bookkeeping** (`668f8c5`) — both perception registries
  materialized the entire document before their element cap applied. The label pass stays
  exhaustive on purpose: a `<label for>` often follows its input, and truncating that pass would
  silently lose sensitive-field detections. Dream consolidation moved from ~1000 serialized
  IndexedDB round trips to batched transactions.

### Removed

- **The research screenshot capability** (`469e6e0`) — wired end to end, never called, and a
  hazard: `captureVisibleTab` composites cross-origin iframe content while every guard on that
  path inspects only the top frame's URL. Deleting it beat documenting it.
- Dead exports `clearRegions`, `closeAllSessions` and `listTabGroups` (`668f8c5`, `469e6e0`).
  `clearRegions` turned out not to be dead but *unwired* — region stamps were being left on the
  user's page after a control session ended — so it was connected instead (`371b2a1`).

---

## [2026-08-09] — Dreaming moves to the offscreen host

Memory consolidation ran in the MV3 service worker, which Chrome can kill mid-task. The
generation now runs in the offscreen document, where a long model call can finish (`2e438f9`).

### Fixed

- **Dream generation no longer races the service-worker lifetime** (`2e438f9`) — the alarm still
  fires in the worker, but the model call itself is dispatched to the offscreen host over a typed
  message channel, with the existing storage-backed reentrancy lock unchanged.

---

## [2026-08-08] — Office document attachments

The composer accepts Word, PowerPoint, Excel, OpenDocument, RTF and EPUB files, converting each
into a normalized document model and a budgeted text representation rather than raw bytes.

### Added

- **Office document ingestion** (`0260b70`, `ed1ec59`) — documents are classified by extension and
  MIME, routed to a budgeted text conversion, and assembled into the outgoing message like any
  other attachment.
- **A normalized document model with prose budgeting** (`79f99aa`) — one shape for every format,
  so downstream code does not branch per file type.
- **Workbook manifests with fair-share row budgeting** (`0de599a`) — a spreadsheet is summarized
  per sheet with rows allocated across sheets rather than exhausted by the first one.
- **A lazily loaded parser shell** (`10b30ac`) — the ~845 KB office parser is imported only when a
  document is actually attached, with sparse-safe mapping of its AST.
- **Document chips** (`b4e1ec0`) — attachment chips show a document icon and a short summary.

### Fixed

- Modern files carrying a legacy MIME type are no longer rejected, and the legacy-format
  suggestion names the right extension (`9bbe296`).
- Image counts reflect real image nodes instead of always reporting zero (`c982a91`).
- A surrogate-pair regression test that could not fail now asserts (`d13fb54`).

---

## [0.3.0] — 2026-08-03 — *Chrome Web Store update*

The second store release. Users get three things they can see — files they can attach to a
message, a conversation that belongs to the tab it was started on, and API keys that are
encrypted where they sit — on top of a whole-codebase adversarial security review.

**No permission changes.** The manifest's only difference from `0.2.0` is an added
`content_security_policy` for extension pages, which narrows what they may load. Existing
installs update without being disabled for a re-grant.

Contents: the two milestones below dated 2026-08-01 and 2026-08-02 in full, plus the fixes at
the tail of 2026-07-28 (duplicate context menus, an invalid research tool name, a hung message
channel) that landed after the `0.2.0` package was cut and so never reached a store user.

---

## [2026-08-02] — Prompt attachments and security hardening

The composer now accepts images, PDFs, and text files, while a whole-codebase adversarial review
closed the highest-risk gaps found in the extension's cross-context and tool boundaries.

### Added

- **Prompt attachments** — drag-and-drop, paste, and paperclip picking feed a provider-aware
  delivery planner. Attachments are classified, byte-capped, stored in the `lychee-attachments`
  IndexedDB store, dehydrated in persisted history, and rehydrated when a chat is reopened.
  Native-document providers receive native file parts; other providers receive the supported
  fallback representation. PDFs are parsed from copied bytes so the PDF worker cannot detach the
  stored buffer.
- **Encrypted-at-rest status** — Settings now shows whether secret storage is sealed and when the
  vault has temporarily fallen back to plaintext-safe behavior.

### Fixed

- **Security review waves** — closed defects across tool authorization, SSRF/browse policy,
  cross-panel settings, render and MCP recovery, service-worker lifetime, dreaming re-entrancy,
  and page-control classification. CloseTabs now reports the verified number of closed tabs, and
  the regression cases are mirrored in the pure browse-policy tests.

## [2026-08-01] — Envelope encryption for secrets at rest

Every secret Lychee stores — provider API keys, Langfuse keys, MCP OAuth tokens, and MCP
header values — is now envelope-encrypted at rest instead of sitting in `chrome.storage.local`
as plaintext. Existing installs migrate automatically the first time they load; there is no
user-facing change and no action required. Design + threat model in
`docs/superpowers/specs/2026-08-01-envelope-encryption-design.md`.

### Added

- **A device-bound key vault** (`src/data/vault.ts`) — a non-extractable AES-KW
  key-encryption key lives in IndexedDB (`lychee-vault`) and wraps an AES-256-GCM data key;
  the DEK itself is never persisted extractable, so no JS in the origin can ever read its raw
  bytes. Sealed values are self-describing `lysec1.<iv>.<ciphertext>` strings
  (`src/data/vaultFormat.ts`), versioned for crypto-agility.
- **Seal/open at the existing chokepoints, not the call sites** — `saveSettings()`/
  `loadSettings()` seal and open `providers[].apiKey`, `observability.publicKey/secretKey`,
  and every MCP server's `headers` value (`src/data/settingsVault.ts`); `src/mcp/auth.ts` seals
  stored OAuth tokens as one unit. In-memory `Settings` stay fully plaintext, so the ~13
  key-reading call sites, the offscreen research handoff, and MCP "Copy JSON" export are
  untouched.
- **Automatic migration** — a plaintext field found on load is sealed, round-trip-verified in
  memory, and written back; the plaintext-read fallback stays permanently, since it is also the
  format detector. A vault that's unavailable (IndexedDB broken/blocked) degrades to plaintext
  writes with a one-time warning rather than bricking key storage, and an undecryptable sealed
  value (lost KEK) resolves to `''` so the user just re-enters the key.
- **`resetVault()` on erase-all** — wiping all data now also destroys the KEK/DEK, so a fresh
  onboarding starts from a fresh vault rather than reusing old key material.

---

## [2026-08-01] — Per-tab chats

A chat now belongs to the tab it was opened on, and a turn survives you walking
away from it. Switching tabs gives you a fresh chat; coming back gives you the old
one. History stays unified — any finished chat can be reopened on any tab. Design
+ research trail in `docs/superpowers/specs/2026-08-01-per-tab-chats-design.md`.

### Added

- **Tab-bound chats** (`src/ui/tabChats.ts`) — a chat is keyed by **tab id + origin**:
  navigating the bound tab to another site starts a new chat, navigating within the
  same site keeps it. The map is mirrored to `chrome.storage.session` rather than
  `.local` on purpose — that area is wiped on browser restart, which is exactly when
  tab ids stop meaning anything, so the keys and the thing they key expire together
  and a stale map can never point a reopened panel at an unrelated tab. `originKey`
  deliberately avoids `URL.origin`, which returns the string `"null"` for the
  opaque-origin schemes an extension actually meets (`file:`, `about:`) and would
  collapse every local file onto one shared chat.
- **Background turns** — `App` mounts a *set* of chats: the visible one plus any still
  running or parked. Idle chats unmount as before, so the usual cost is one chat, not
  one per tab. Chats are keyed by conversation id, so switching tabs never re-mounts —
  and so never restarts — a turn already in flight.
- **Tab parking** — captures and page-control steps need their tab frontmost
  (`captureVisibleTab` only ever returns the *active* tab; a click on a background tab
  shows the user nothing). Rather than fail, they stop the turn with a new `parked`
  stop reason and resume automatically when the user returns. A model told merely that
  something "failed" spends the rest of its budget retrying. The page-control session
  survives a park, so returning resumes the flow mid-plan instead of asking for control
  a second time.
- **Landing notifications** — a bar in the panel plus a `chrome.notifications` toast when
  a background chat finishes, parks, or needs approval. The tab id rides in the
  notification id, so `background.ts` routes a click without any state — the panel that
  raised it may be closed by then, and the worker is the only thing guaranteed to still
  be there. Permission toasts name the tool being requested and set `requireInteraction`,
  since an approval blocks the turn until answered.

### Changed

- **`createAgentTools` takes a `PageTarget`** — all nine page tools resolved their target
  through `getActiveTab`, so a turn still running after a tab switch would silently start
  acting on whatever page the user moved to. They now route through an injected
  `resolveTab`, defaulting to `getActiveTab` for callers that aren't tab-bound. The
  no-tab error became one constant worded to be true of both: "no active tab" is a lie
  for a bound chat whose tab was closed, and the model would keep retrying against a tab
  that is never coming back.
- **Hidden chats suppress their ambient effects** — a mounted-but-invisible chat must not
  keep resolving "the active tab": the context pill would show, and later attach, a page
  the conversation was never about, and every hidden chat would inject a selection-reading
  script into the user's page once a second on top of the visible chat's own poll. The
  turn loop, persistence and research effects deliberately keep running — that is the
  reason it stays mounted.
- **Blocked chats are announced on state, not transition** — a turn finishes once, but a
  chat can be left waiting two ways: the approval card appears while the user is elsewhere
  (a transition), or it appears while they are watching and they switch away afterwards.
  The second changes no status at all, so a transition-based check never fired and the
  chat sat blocked in silence.
- **More loader phrases** — the thinking/digesting lists were short enough that a long turn
  repeated itself.

### Fixed

- **The landed bar no longer outlives its purpose** — it kept advertising a chat the user
  had already reached by switching to its tab by hand, rather than by clicking through.
- **Test suite resolves pdfjs from a worktree** — a git worktree symlinks `node_modules` at
  the main checkout and Vite resolved the `pdf.worker.min.mjs?url` import to its real path,
  outside the worktree root, tripping Vite's filesystem guard. The suite was green in the
  main checkout and red in every worktree.

---

## [0.2.0] — 2026-08-01 — *first Chrome Web Store release*

The initial public listing: a side-panel assistant with bring-your-own-model support, page
reading, approved page control, tab organising, background research with citations, long-term
memory, skills, MCP tool servers, and sandboxed code execution. Passed review first time.

Contents: every milestone below, plus the *Added* items of 2026-07-28 — that milestone is split
across two releases, since its fixes landed after the package was cut and shipped in `0.3.0`.

---

## [2026-07-28] — Tab management and reply self-correction

### Added

- **Semantic tab tools** — the agent can understand, group, and close tabs with verified results;
  the Chrome Web Store listing and permission justification now describe the `tabGroups` use.
- **Regenerate** — the last assistant reply can be regenerated, with failures fed back into the
  next attempt so the model can self-correct.

### Fixed

- Duplicate context-menu registration, an invalid tool name, a hung message channel, stale
  highlight rings, and accidental tracking of the `node_modules` symlink are now covered by the
  corresponding fixes and tests.

---

## [2026-07-27] — Chrome Web Store readiness

Preparation for the first store submission. No behavioural change to the extension itself —
one redundant permission dropped, plus the publishing paperwork the review process requires.

### Added

- **`CHROMEWEBSTORE.md`** — the single source of truth for the store listing: submission-ready
  copy, a per-permission justification table written for reviewers, the data-use disclosure
  derived from an audit of the real code paths, and review notes pre-empting the three things
  most likely to draw scrutiny (single purpose, `<all_urls>`, and the remote-code question that
  `RunCode` and MCP app views superficially resemble). Excluded from the upload package.
- **`PRIVACY.md`** — the privacy policy the store requires, enumerating every endpoint the
  extension actually contacts (the user's provider, DuckDuckGo, OpenAlex, Wikimedia Commons,
  Openverse, user-added MCP servers, and opt-in Langfuse) and every local store. Must be hosted
  at a publicly reachable URL before submission.
- **`scripts/package.sh` + `npm run package`** — builds and zips `dist/` into an upload-ready
  archive. Zips the *inside* of `dist/` so `manifest.json` lands at the archive root (Chrome
  rejects a manifest one directory down), fails fast when `manifest.json` and `package.json`
  versions disagree, asserts every entry point built, and strips source maps and `.DS_Store`.
- **`homepage_url`** in the manifest, pointing at the repository.

### Removed

- **`activeTab` permission** — never used, and redundant beside `<all_urls>` + `tabs`, which
  already cover every path that touches a tab. It could not have worked for this UI anyway:
  `activeTab` is granted only on a direct gesture on the extension's own surfaces, which a
  button inside the side panel is not. One fewer permission for review to question.

---

## [2026-07-27] — Sandboxed code execution & artifacts

The agent can now *run code* and *build things*, entirely client-side. A second
manifest-sandboxed page (`sandbox-exec.html`) is the sealed execution surface: opaque origin,
no `chrome.*`, no network (`connect-src 'none'` meta CSP), assets delivered by postMessage
byte-transfer from the panel (an opaque origin fails CORS against `chrome-extension://`).
Design + research trail in `docs/superpowers/specs/2026-07-27-sandboxed-code-execution-design.md`.

### Added

- **`RunCode` tool** — executes JavaScript in a throwaway QuickJS-wasm interpreter
  (`quickjs-emscripten-core`, ~500 KB) inside the sealed sandbox, with a hard memory cap and an
  instruction-level interrupt for wall-clock timeouts. Console output + completion value return
  under strict budgets (`src/exec/protocol.ts`); oversized values spill to a user-facing
  artifact instead of bloating model history. Gated by `requestApproval` with the code shown on
  the card.
- **Artifacts** — `CreateArtifact`/`UpdateArtifact` tools store self-contained HTML documents in
  a new `lychee-artifacts` IndexedDB store (byte-cap pruned, newest always survives; new
  Data-tab row; cascaded on chat delete) and render as `ArtifactCard`s that mount the sealed
  sandbox in render mode — artifact scripts run in a nested scripts-only `srcdoc` iframe, never
  `allow-same-origin`.
- **Second Vite build** (`vite.sandbox.config.ts`) emits the sandbox runtime as a classic IIFE
  (`dist/sandbox-exec.js`) — a module script would fail the opaque-origin CORS check — with the
  emscripten wasm reference stubbed out (the panel transfers the real bytes, saving ~670 KB of
  dead base64).
- **Per-conversation delete cascade** — deleting a chat now also drops its screenshots, MCP
  content and artifacts (the stores documented this intent but nothing called them).

---

## [2026-07-20] — Providers & reasoning, agent steering, screenshots v2, resilient research

The largest single-day drop in the project's history: a per-provider capability layer that makes
reasoning models work correctly across OpenAI, Anthropic, Groq, Ollama, LM Studio and OpenRouter;
mid-task **agent steering**; a second-generation screenshot subsystem; configurable memory
dreaming; and a deadline-aware, crash-resilient background-research engine.

### Added

- **Per-provider capability profiles + hybrid adapter dispatch** (`a69886f`). Introduced a
  `ProviderKind` and a per-model config layer (`settings.ts`) plus a pure, unit-tested
  capability-profile module (`providerProfiles.ts`) that encodes, for each provider kind, its
  reasoning wire dialect, reasoning-model detection heuristic, effort-slider rungs, and
  model-list endpoint. `createModel` now dispatches on kind instead of assuming one adapter:
  **OpenAI** runs on the **native Responses API** (the only path where reasoning and function
  tools coexist — chat-completions `400`s that pairing), **Anthropic** on the **native Messages
  API** (native "thinking"), and **Groq / Ollama / LM Studio / OpenRouter / custom** stay on the
  OpenAI-compatible adapter. Reasoning is injected two ways: native adapters via a
  `providerOptions` middleware, compatible adapters via a request-body transform (including
  Groq's mandatory `reasoning_format: 'parsed'` whenever tools ride along, or it `400`s). +21
  unit tests (191 total).
- **Opt-in per-provider `reasoningEffort` for gpt-5-class tool use** (`987e5a9`). OpenAI defaults
  `reasoning_effort` to a non-`'none'` value server-side for reasoning models like `gpt-5.6-luna`
  and then rejects the request once function tools are attached — which made such models unusable,
  since every agent turn here is tool-driven. Added an opt-in effort knob injected through the
  request-body hook. (This was the narrow first fix; `a69886f`, 43 minutes later, subsumed it by
  moving OpenAI off chat-completions entirely.)
- **Reasoning-effort slider inside a custom model dropdown** (`4fd50f3`). Replaced the composer's
  native `<select>` with a `ModelPicker`: models grouped by provider, plus a **Faster ↔ Smarter**
  snap-slider pinned to the footer, shown only for reasoning models. Rungs and detection come from
  the provider profile; the chosen effort is stored per model (`modelConfigs`), with a manual
  override for when auto-detection guesses wrong on an unfamiliar local id. Extracted
  `useDismissOnOutside` into `src/ui/hooks.ts`, now shared by the tools popover and the picker.
- **LM Studio preset + "Refresh models" from each endpoint** (`71997ba`). Added an LM Studio
  preset (`kind: lmstudio`, `localhost:1234/v1`) and tagged every preset with its kind. A
  per-provider "Refresh from endpoint" action fetches the live model list via the profile's
  endpoint and auth scheme (OpenAI bearer / Anthropic `x-api-key`+version / OpenRouter public /
  LM Studio's native `/api/v0`) and seeds a reasoning flag where the API reports one the id
  heuristic would miss. Response-shape parsing is pure + unit-tested (6 tests).
- **Collapsible "Thinking" reasoning block** (`689ef59`). `reasoning-delta` stream chunks are now
  captured into a dedicated `reasoning` UI part (consecutive bursts merged) and rendered in the
  transcript as a collapsible disclosure — auto-open while streaming so you can watch the model
  think, folded away once reloaded from history. Reasoning is display-only: persisted on the UI
  message but stripped from the model-replay history. The background research sheet folds
  reasoning into its existing "Thinking" log rows.
- **Configurable memory dreaming** (`f0f96c4`). Dreaming was hardcoded to run at most every ~20h
  using the chat model, with no way to trigger or reset it. The Memory panel now offers: an
  **interval picker** (30 min–24 h, default 24 h, stored as `dreamIntervalMs`) — the background
  alarm period adapts to `min(interval, 60min)` and reschedules on settings change, so a short
  interval is genuinely honoured; a **dreaming-model picker** (`dreamModel`, falling back to the
  chat model), mirroring `titleModel`; a **"Dream now"** button that runs a cycle on demand,
  bypassing the interval/idle gates; and a **"Reset memory"** button that wipes memories, episodes
  and dream state in one shared path. The 30-minute idle guard remains fixed (it is a safety
  property, not a preference).
- **`GetScreenshot` + `GetElementScreenshot`, available to text-only models** (`80030e8`,
  `d919565`, `1099b4f`, `89369a6`). The single `Screenshot` tool was split into `GetScreenshot`
  (rendered viewport, `fullPage:true` for the stitched strip) and `GetElementScreenshot` (one
  `[rN]`/selector region), and — critically — the tools are now **always present**, even for a
  model that fails the vision probe. A new pure, unit-tested router, `planShotDelivery`, decides
  per capture whether the image is sent to the model (`send`) or withheld while still saved and
  rendered for the user, with a plain-text note back to the model so a blind model does not loop
  (`blind`/`budget`). Every capture is a user-facing artifact regardless of whether the model can
  see it.
- **Consecutive-screenshot carousel** (`fe5dbd4`). Consecutive screenshot captures group into a
  single swipeable carousel in the transcript, and raw tool-call JSON is dropped from the display.
- **Agent steering — redirect a turn mid-flight** (`9876c52`, then reworked by `6fe2e35`,
  `cd57257`, `d306b80`). The user can now inject a follow-up into a *running* turn without
  stopping and restarting. `runAgentTurn` gained a `steerPending` predicate OR'd into `stopWhen`,
  halting the cycle cleanly at the next **step boundary** (never mid-token, never mid-tool, never
  mid-click — so a steer can't jump an open approval card); `runTurnChain` drains the queued steer
  into history as a real user message, opens a fresh assistant bubble, and continues the
  continuation chain on a fresh step budget that is *not* counted against auto-continues. Steers
  reuse the composer's message assembly (`buildUserTurn`), so they carry screenshots, page
  selection, deictic "this page", `@memory` and `@all` identically. After iteration, the final UX
  makes **queuing the default and steering opt-in**: a message sent while the agent works is parked
  in a subtle in-flight strip joined to the composer, with a **"Steer now"** button to inject it
  immediately (↳ redirect-arrow icon) or a retract control to pull it back; left alone, it
  auto-sends as an ordinary follow-up the moment the turn finishes. Locked by a regression test in
  `agent.test.ts`.
- **`NavigateTab` navigation-intent animation** (`070a9d0`). Before a `goto` swaps the current
  page out, an on-page cue plays in the agent-presence language: the cursor glides to centre, a
  "Navigating to `<host>`…" pill pops, then the tint ramps to a heavier dark wash lit by a drifting
  blue shimmer. `goto` only (open starts blank; activate loads no URL); best-effort, so a restricted
  page just skips the cue and navigates.
- **Resilient background research** (`692dc5e`, `458c25d`, `d4bb7c6`, `02a4c5e`, `f825e04`,
  `8f02895`, `f301ef0`). Long research runs are now crash- and stall-resistant: a deadline-aware
  retry module with backoff (`692dc5e`); a 24-hour deadline with resume-from-notebook and resilient
  phases that finalise a **partial report** rather than losing everything on a late failure
  (`d4bb7c6`, `f301ef0`); an offscreen double-run guard plus heartbeat and pause/resume wiring
  (`02a4c5e`); a watchdog `chrome.alarms` tick, resume-on-startup, and paused/resumed/heartbeat
  handlers (`f825e04`); new paused/deadline/resume fields and watchdog selectors on the task model
  (`458c25d`); and UI for paused/waiting and partial-report states (`8f02895`).
- **Composer & message quality-of-life** (`0a1a05b`). A hover-revealed **Copy** button under each
  user bubble; **ArrowUp on an empty composer recalls the previous message** (shell-style); the
  composer **auto-focuses** on panel open and on every new/switched chat; **ESC aborts an
  in-progress region capture** (a new `cancelRegionCapture` injects a synthetic Escape so the page
  overlay's own cancel path runs); and the Thinking block auto-collapses the instant the model
  stops reasoning and begins its answer (manual toggle still wins).

### Changed

- **`createModel` adapter selection is now driven by capability profiles, not a single
  OpenAI-compatible assumption** (`a69886f`, `eb9cbc4`). CLAUDE.md and the README were rewritten to
  describe the per-kind profile layer, the native OpenAI (Responses) / Anthropic (Messages)
  adapters vs. OpenAI-compatible, per-model reasoning + the effort slider, LM Studio, and
  Refresh-from-endpoint.
- **Tool-disclosure prompt now opens affirmatively** (`fcbd179`). `TOOL_DISCLOSURE_NOTE` was
  reworded because the small visible tool set (`ReadPage` + the two disclosure meta-tools) read as
  "I can't", so models answered actionable requests ("open my gmail tab") in plain text without
  loading the capability. The note now states plainly that the agent *can* act and adds a hard rule:
  never tell the user you can't do a browser action before calling `ToolSearch` to check. It lives
  in the always-appended note, so every install gets it regardless of a saved base prompt.
- **Per-reply token count removed from the UI** (`cddc3e7`). The "… tok" line was dropped from the
  message toolbar (usage is still tracked on messages, just not shown); the reasoning-effort slider
  was restyled as a recessed inset groove with a lychee-gradient fill.

### Improved

- **Model menu scrolls under the pinned effort footer** (`003c99f`) — added `min-height: 0` so a
  long model list can shrink and scroll instead of pushing the effort slider out of the popover.
- **Steering UX consolidated to a single composer** (`6fe2e35`) — the detached accent "red box"
  became a subtle status strip joined to the top of the composer (mirroring the research dock), the
  composer is no longer disabled during a turn, and `send()`/`steer()` were merged into one
  `submit()` that samples `streaming` at submit time (idle → fresh turn, in-flight → steer). Net
  −143 lines, one text box, one attachment tray, with Stop beside the send arrow while working.
- **Screenshot pills enlarge in place** (`fd10a27`, work-in-progress) — a screenshot pill renders
  the capture inline and enlarges the full-resolution PNG on click (lazy-loaded, with
  Shrink/Download controls); `copyElementAsPng` gained an exclude selector so a copied reply image
  shows only the response prose (excluding `.reasoning-block, .tool-pill`).

### Fixed

- **Replayed reasoning parts no longer trip an SDK warning** (`af0ba74`). OpenAI's Responses
  adapter warns *"Non-OpenAI reasoning parts are not supported. Skipping reasoning part"* when
  replayed assistant reasoning lacks its provider metadata — which it always does after the app's
  JSON round-trip persistence. `toValidModelMessages` now drops reasoning parts (and any assistant
  message left empty as a result) before replay: the same effective request the SDK was already
  sending, minus the warning.
- **User copy-button tooltip stays inside the panel** (`639b8a4`) — the right-aligned button's
  tooltip anchored `left:0` and grew off-screen; it now grows inward.
- **Camera button stays visible at narrow widths** (`e17db29`) — at ≤360px only the tools button
  collapses into the "…" menu; the screenshot camera keeps its own composer button at every width,
  and the redundant "…"-menu screenshot item was removed.

---

## [2026-07-13] — Rebrand to Lychee AI, agent vision, autonomous browsing, LaTeX self-correction, settings overhaul

### Added

- **Rebrand to Lychee AI** (`6caa96e`). The extension shipped with no icon (Chrome's default letter
  tile) and a placeholder indigo "R" for research notifications. This landed a flat geometric lychee
  icon at 16/32/48/128 (wired into `icons` and `action.default_icon`; the notification now uses the
  real 128px icon and the `OffscreenCanvas` hack is gone); a brand-red accent palette on the accent
  tokens only (the neutral ramp untouched, since a warm cast hurts long transcripts) — UI red
  `#c9304a` / `#f2687e`, deliberately a shade deeper than the logo's crimson so it clears WCAG AA;
  a hopping-lychee loader (SVG + CSS, squash-and-stretch, honouring `prefers-reduced-motion`); the
  agent's own name ("You are Lychee" in `DEFAULT_SYSTEM_PROMPT`, refreshing a persisted copy that
  still matches the old default); and renamed `lychee-*` IndexedDB stores (no migration, by request —
  existing conversations/skills/memories/screenshots are abandoned). Repo-only art lives in `assets/`,
  outside `public/`, so it never ships in the bundle. README rewritten against what the code actually
  ships.
- **Agent screenshot tool — webpage & element-level capture** (`6f0249a`). Gave the agent eyes: it
  can look at the viewport, a single element, or the whole scrolled page, so it can read
  charts/diagrams/layout that text extraction flattens and check its own work after a `ControlPage`
  action. Introduced `regionIndex.ts` (a second perception registry answering "what can I look
  at?" — figures, tables, media, cards, landmarks; whole-document, addressed `[rN]` so it can never
  be confused with the click registry's `[N]`; surfaced via `ReadPage(mode:"regions")`) and
  `screenshot.ts` (a capture engine doing viewport/element/fullpage via scroll-and-stitch, with pure
  unit-tested `planStitch`/`planTiles`, sticky/fixed elements hidden from the second slice onward,
  and scroll/styles restored in a `finally`). A tall page is one artifact for the user but sequential
  full-resolution tiles for the model. Screenshots persist in their own IndexedDB store (pruned by
  age + size); the transcript holds only a `shotId`. `imageQueue` entries gained per-item captions.
  (In this first cut, the tool was removed entirely from the ToolSet for text-only models — later
  superseded on 20 July by `planShotDelivery`.)
- **Autonomous background-tab browsing (`BrowseSite`) + surfaced reasoning & findings** (`876a9cb`).
  The research agent could previously only fetch/render pages one-shot; a 403 or bot wall was a dead
  end. Added `researchTab.ts` (a lease-based isolated tab — incognito, mutex'd, orphan-swept — shared
  by the one-shot renderer and the new browse session), `researchBrowse.ts` + `browsePolicy.ts` (a
  stateful, policy-checked browse session where — with no human at the gate — the pure, exhaustively
  unit-tested policy *is* the security model: read + navigate + site-search only; never a login,
  purchase, or non-search form submit), and `browseAgent.ts` (a nested sub-agent in its own context
  that walks the page, writes findings to the shared notebook, and returns a digest). `FetchUrl` now
  hints at `BrowseSite` when a plain fetch is refused, and the research sheet gained reasoning rows,
  a live Findings section, nested browse steps, and sources that appear while the task runs.
- **Tabbed Library (Chats / Skills / Research)** (`8714c7a`). Replaced the single-purpose Skills
  overlay with a tabbed archive behind the archival-box icon: **Chats** (full conversation history,
  click to open, hover-trash to delete), **Skills** (the library in list form, reusing the extracted
  `SkillEditor.tsx`), and **Research** (every background-research task across chats, newest-first,
  with a status pill and source count; clicking navigates to the originating conversation and reveals
  the live sheet or scrolls to the report card).
- **LaTeX self-correction / validation loop** (`d983878`, `6f6529f`, `93aec77`, `57afb0b`,
  `8c343c2`). Built the fix for a reproduced KaTeX failure where a single stray or unbalanced `$`
  mid-paragraph desyncs `$…$` pairing and drags neighbouring valid math into raw text. Two layers,
  cheap-first: a **deterministic validator/neutraliser** (`d983878`) run before the final render
  (`6f6529f`), pure and unit-tested, bounded to structural, KaTeX-detectable errors (`d59ab80`); and
  a **silent post-turn repair pass** (`93aec77` primitives → `57afb0b` orchestrator → `8c343c2`) that
  re-asks the model to fix math a bubble still can't compile, splicing the correction back by offset
  after the turn so it never blocks streaming (driving a "fixing math…" indicator).
- **Settings UI/UX overhaul — Providers + Data tabs, permissions accordion** (`80e1170`, `040d841`,
  `b166099`, `ab39eee`, `6a8b875`, `9b1bc8b`, `a7245fc`, `6651c46`). Providers get their own tab with
  collapsible cards (`80e1170`); a new **Data tab** surfaces storage usage, scoped per-store clears,
  and a danger-zone full erase (`040d841`, `6651c46`, `a7245fc`, backed by a pure byte-estimation
  leaf `9b1bc8b`); tool policies collapse into a group accordion whose permission copy is derived from
  the policy itself (`b166099`); and shared `Section`/`Disclosure` primitives plus a scrollable tab
  strip were introduced (`ab39eee`), with pure group-policy and reset helpers (`6a8b875`).
- **Opt-in Langfuse observability (beta)** (`a92711f`). A beta toggle in Settings → General streams
  deep observability for every model-related action to the user's own Langfuse project — off by
  default, with no network request until enabled. A browser-safe, zero-dependency batched ingestion
  client posts to Langfuse's `/api/public/ingestion` over `fetch` (the official OTel path is
  Node-only and can't run in MV3), behind an `Observer` façade with a no-op disabled path and
  content/screenshot redaction. Instrumented surfaces: chat turns (per-step generations, tool spans,
  approval outcomes, token usage), chat-title, research, `ExtractData`, the vision probe, and memory
  dreaming.
- **Token + cost tracking** (`eb3d69d`) — *partially reverted the next day; see Changed below.*
  Added `AgentTurnResult.usage`, per-message `usage`/`costUsd`, `agent/usage.ts` helpers, optional
  per-model pricing, and per-reply/running-total displays. Root-cause fix bundled: `@ai-sdk/openai-compatible`
  only sends `stream_options: { include_usage: true }` when `includeUsage` is set (default off), so
  streaming endpoints returned no usage block at all — now enabled in `provider.ts`.
- **Collapsible research report card** (`eedde2a`) — clicking the report card's header toggles a
  collapsed state (rotating caret) that hides the body + copy/sources toolbar; starts expanded.

### Changed

- **Reverted token-total pill and per-model pricing** (`681d9db`). Removed the "Σ N tok" chat-total
  pill, the Settings pricing table, and the whole cost path it fed (`modelPrices`,
  `computeCost`/`formatUsd`, `UIMessage.costUsd`, and Langfuse `costDetails`) — keeping a setting
  without an editor would be dead config. Cost now lives in Langfuse, which prices generations from
  its own model table. **Kept** the per-reply token count and full `usageDetails` on every generation.
  Also fixed a composer overflow where a long model id refused to shrink the row (`min-width:0` +
  ellipsis on the select, `flex:none` on the actions) and added a hybrid overflow menu below 360px.
- **Chat title generation reworked** (`c521c73`). Naming a chat was "a coin flip" — a one-shot,
  un-retried `generateText` with a hard **20s abort** while a reasoning model spends ~2k tokens of
  chain-of-thought on four words (measured against a local qwen3.6-35b: median 16.8s, max 25.7s).
  Failures returned `null`, were swallowed, and — since titling was attempted only on the first
  message — stranded chats on "New chat" forever. Fix: budget **20s → 60s**; run it at turn-end (not
  from `send`, so it never queues behind its own turn); retry on each finished turn while untitled
  (max 3); collapse the title write + turn save into one IndexedDB transaction to avoid a lost update;
  extract a pure, tested `sanitizeTitle`; and add an optional non-reasoning `titleModel`.

### Fixed

- **`$$…$$` display block glued to the previous line now renders** (`58d27ea`).
- **Delimiter-less LaTeX repairs are rejected and corrected math is persisted** (`1b113d2`) — a model
  that "fixes" `$x$` into a bare `x` can no longer silently delete the math it was asked to save.
- **Every text part of a bubble is repaired, not just the first** (`de36132`) — a reply with two
  math-bearing paragraphs previously had only the first healed.
- **Tab-search fallback for bot-throttled search + null-window crash** (`1eaee6e`). `WebSearch` failed
  when DuckDuckGo served a 202/429 bot wall to the keyless fetch (a plain `fetch()` can't set a
  `User-Agent` and carries a `chrome-extension` origin); it now retries the query in the real isolated
  research tab — a genuine SERP that clears the wall — and scrapes the rendered results (transparent to
  the model). Also fixed a `BrowseSite` crash where `windows.create({incognito:true})` *resolves* null
  on some Chrome builds instead of rejecting, so the fallback never ran; `ensureTab` now treats a
  null/idless window as "incognito unavailable". Added `parseDuckDuckGoHtml`/`resolveDdgHref` (pure,
  tested).
- **Disabled buttons finally look disabled** (`ac74f9a`) — there was no `.btn:disabled` rule at all,
  so the solid-red Erase button looked armed while inert; fixes every disabled `.btn`.
- **Form controls styled by what they are, not where they sit** (`fb4b026`) — the chat-naming
  `<select>` wore the browser's default chrome because controls were styled only by ancestor-scoped
  rules; added a control-keyed baseline for the settings pane, a redrawn select chevron, and a `Select`
  primitive so a new field is dressed by virtue of being one.
- **Observability toggle no longer collides with the `.switch` style** (`3ee4cc3`) — SkillsTab's bare
  `<input class="switch">` and GeneralTab's label-based observability switch shared a class and rendered
  as a broken double-circle; the label-based toggle was renamed `.switch-toggle`.

---

## [2026-07-12] — Progressive tool disclosure, the deep-research pipeline, observability

### Added

- **Progressive tool disclosure** (`ce644aa`, `27f1c4a`, `7a4a32e`, `525385f`). Only an always-on core
  (`ToolSearch`, `GetTool`, `ReadPage`) is active per step; the model lists the rest via `ToolSearch`
  and loads them with `GetTool`, which adds to a per-turn `activeNames` set that `prepareStep` turns
  into the step's AI SDK `activeTools`. Built on a pure, unit-tested tool-discovery module
  (catalog/search/active-set, `ce644aa`) and activated with `activeNames` seeding + a disclosure prompt
  note (`525385f`).
- **Consolidated tool surface** (`58b0fe6`, `25b6694`, `2cb5795`). Merged `ViewCurrentTab` /
  `GetActiveTabDOM` / `InspectPage` into **`ReadPage`**, `ViewOpenedTabs` / `GetAllDOM` into
  **`ReadTabs`**, and the browsing-insight tools into **`QueryBrowserData`**, retargeting all
  references — a smaller, clearer catalog for the disclosure layer to expose.
- **Deep-research pipeline — a phased state machine over a notebook** (`3158635`, `b857682`, `5a98691`,
  `06137b8`, `f335ca0`). Replaced the flat search→fetch→synthesize loop with a structured
  **Scope&Plan → (Gather ↔ Reflect) → Synthesize → Verify** state machine over a `ResearchNotebook`
  (plan, sources, findings, images, coverage) that is the long-horizon memory; gather rounds start
  fresh from a notebook *summary* rather than a growing history (`3158635`). Added a **verification &
  grounding** pass — a citation-grounding audit plus bounded adversarial refutation of top claims, then
  a hedging revise pass, surfaced as a "Verified · N confirmed · M hedged" badge (`b857682`); **inline
  favicon citations** via `[[n]]` sentinels that survive `marked` + DOMPurify as private-use code points
  and render as favicon chips, degrading to portable `[n]` on copy (`5a98691`); a **hybrid
  tab-escalation broker** so an empty headless fetch renders the URL in an isolated background tab and
  extracts readable text, SSRF-guarded, one render at a time (`06137b8`); and **academic/image/table
  modalities** — keyless `SearchAcademic` (OpenAlex), `SearchImages` (Wikimedia Commons + Openverse),
  `HarvestImages`, and `ExtractTable`, with attribution-first inline image embedding (`f335ca0`). Pure
  logic unit-tested throughout (55 tests total by the end of the phase).
- **Opt-in Langfuse observability (beta)** (`a92711f`) — see the 13 July section for the full
  description; the feature landed on the 12th and was refined the next day.
- **Token + cost tracking** (`eb3d69d`) — landed on the 12th; largely reverted on the 13th (`681d9db`).

### Fixed

- **Reflect-coverage mapping** (`b8a304a`) — the model paraphrases sub-questions in its coverage
  assessment, so keying coverage by the echoed text left `openGaps`/`isFullyCovered` never matching and
  the loop ran all rounds; assessments are now mapped to the verbatim focus questions by index.
- **Calls to unloaded tools self-heal into `GetTool`** (`5d6853e`). Under `activeTools`, calling a
  not-yet-loaded tool is rejected with `NoSuchToolError` *before* `execute()` runs, so a gated tool's
  approval card never appeared and the model had no way back — after denying page control it could never
  re-ask. `repairToolCall` now rewrites a call naming a *real but unloaded* tool into `GetTool`, loading
  it so the next call reaches its permission card; policy/permission-removed tools stay unresurrectable
  and hallucinated names still error.
- **Langfuse ingestion failures are surfaced, not swallowed** (`e5adcaf`). Langfuse answers *input*
  errors with `207` + a per-event `errors` list, not a `4xx`, so `res.ok` was true even when every event
  was rejected — a fully-rejected batch looked like success and "Test connection" reported ✓ falsely.
  `flush()` and `testLangfuseConnection()` now parse the response and report the real reason
  (auth/region, rejection detail, network/CORS); `getObserver()` warns once when enabled but
  misconfigured. Observability stays non-fatal to a turn.
- **Observability settings UI** (`9591189`) — labels/inputs rendered inline and unstyled because
  stacked-field rules were scoped to `.provider-card` only; the selectors were extended to `.obs-panel`,
  the panel given a card surface, and the section moved below Providers (configure a model first, then
  decide whether to trace it).

---

### A note on the shape of this window

Across 12–20 July 2026 (111 commits), roughly a third produced no feature code at all — 20 are design
specs and implementation plans under
[`docs/superpowers/`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/tree/main/docs/superpowers),
and another 20 are fixes and hardening *after* a feature already "worked." Nearly every capability above
landed as the same sequence — `docs: design → docs: plan → feat → fix` — which is why so many entries in
the **Fixed** and **Changed** sections are follow-ups to their own **Added** entry a few commits earlier.
