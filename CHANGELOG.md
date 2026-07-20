# Changelog

All notable changes to **Lychee AI** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Lychee AI
is still pre-release (`0.1.0`) and carries no git tags yet, so the sections below are grouped
by **development milestone (date)** rather than by released version — each date is a distinct
burst of work on `main`. Short commit hashes are given in parentheses so any entry can be
traced back to its change.

This log covers **12 July 2026 onward**. The project's first two days (10–11 July 2026) — the
initial side-panel, onboarding, model settings, memory/dreaming, `@mentions`, page control,
the approval gate, and the `AutofillForm`/`profile`-memory groundwork — predate this window and
are not itemised here; see the [wiki Engineering Log](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/wiki)
for that history.

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
