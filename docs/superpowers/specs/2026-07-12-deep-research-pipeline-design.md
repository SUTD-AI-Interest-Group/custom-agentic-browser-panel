# Deep-Research Pipeline — Design

- **Date:** 2026-07-12
- **Status:** Approved (design); implementation pending
- **Branch / worktree:** `deep-research-pipeline` (`.claude/worktrees/deep-research-pipeline`), based on `main@47e7055`
- **Supersedes/extends:** the current background research agent (`src/agent/research.ts`, `src/tools/research.ts`)

## 1. Context & problem

The background research agent is a single-agent, three-tool loop:

- `WebSearch` → DuckDuckGo **lite HTML scraping** (`searchDuckDuckGo`, keyless, fragile parse, 202/429 backoff)
- `FetchUrl` → raw `fetch()` + `DOMParser` readable text (`extractReadableText`, 20K-char cap, **no JS rendering**)
- `ExtractDataText` → a second LLM call for structured JSON
- Loop (`runResearch`): plan → search → fetch → extract → synthesize a `[n]`-cited Markdown report, auto-continuing up to `RESEARCH_MAX_AUTO_CONTINUES` (5) cycles via the ungated `Checkpoint` hand-off.

It runs **headless in the offscreen document** (`src/background/offscreen.ts`), which has only `chrome.runtime` + Web APIs — **no** `chrome.tabs`/`storage`/`notifications`. The task survives the panel closing and fires a notification on completion (fire-and-forget).

### Gaps that make it "primitive"

1. **One fragile search backend** — no ranking/freshness/operators/fallback; DDG-lite blocks easily.
2. **Blind to the modern web** — no JS rendering: SPAs, paywalls, infinite-scroll and **PDFs** return little/nothing. The extension already owns a full browser + page-control infra (`domIndex`, `pageActions`, `marks`, `vision.ts`) that research never touches.
3. **Flat loop** — no explicit plan artifact, no source triage/dedup/rerank, no coverage tracking.
4. **No verification** — citations are model-self-reported `[n]`; nothing checks the source actually grounds the claim.
5. **Single modality** — text only; no academic/PDF, tables, or images.

## 2. Goals / non-goals

**Goals**
- Restructure the loop into an explicit **plan → gather → reflect → synthesize → verify** state machine over a structured **notebook** (long-horizon memory).
- Add **citation grounding + an adversarial verification pass** so reports don't ship hallucinated citations.
- Give research **real-web reach** via **hybrid escalation**: headless `fetch()` by default; escalate a single URL to a service-worker-brokered controlled tab (page-control + vision) only when needed (JS/paywall/PDF/screenshot).
- Add an **image modality**: keyless image research (Wikimedia Commons + Openverse + page harvest + vision-read of charts) and **embed relevant, attributed images into the report**.
- Replace inline `[n]` citations with **inline favicon citations** reusing the chat's existing favicon machinery.

**Non-goals (YAGNI / explicitly descoped)**
- No multi-agent orchestrator / parallel subagents — the chosen model is **sequential + structured** (single agent, one context, no tab contention).
- No commercial search APIs (Tavily/Exa/Serper/Brave). DDG-lite stays the default web search; retrieval-provider swapping is out of scope (a thin seam is acceptable but not required).
- No plan-approval gate or mid-run steering — launch stays **fire-and-forget**; the plan is *shown*, never blocks.
- No caching of image bytes as data URLs (bloats `chrome.storage`); images embed by remote URL.

## 3. Locked decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Tracks in scope | Structured workflow · Verification & grounding · Agentic browsing + modalities |
| Browsing model | **Hybrid escalation** (headless default → SW-brokered controlled tab) |
| Parallelism | **Sequential structured** (single agent + plan + notebook + reflection) |
| Autonomy | **Fire-and-forget + visible plan** (one approval at launch; plan shown, non-blocking) |
| Image sources | **Keyless + attribution-first** (Wikimedia Commons + Openverse + page harvest + vision) |
| Citations | **Inline favicon chips** replacing `[n]`, reusing chat `faviconUrl`/`Favicon`/`SourceCard` |

## 4. Architecture & data flow

Three existing tiers, one new broker. Offscreen stays the brain (survives panel close); the **service worker is the only tier that can touch a tab**, so it brokers escalation.

```
 PANEL (Chat.tsx)              OFFSCREEN (headless research host)            SW (background.ts)
  StartResearch (gated once) →  runResearch controller = state machine
  research sheet: plan +          Scope&Plan → Gather → Reflect → Synthesize → Verify
    coverage + steps (live)         │  Notebook (structured memory)
  report card (non-blocking) ←      │  default: headless fetch()/search   (fast, survives close)
                                    │  escalate hard URL ── renderPage msg ──▶ tab broker
                                    │                                          - isFetchableUrl guard
                                    │  { text, screenshot? } ◀── result ───────- open isolated tab
                                    ▼                                          - page-control render
                              persist Notebook + report in researchTasks         + captureVisibleTab
                              (chrome.storage.local, via SW relay)             - mutex(1), idle teardown
```

The offscreen ↔ SW ↔ panel message protocol in `src/data/researchTasks.ts` is extended (see §8). The panel continues to relay persistence (offscreen can't touch `chrome.storage`).

## 5. Components

### 5.1 Research controller — the structured loop (`src/agent/research.ts`)

Replace the flat cycle loop with an explicit state machine. Each state is one or more `runAgentTurn` calls sharing the growing `history` **plus** the notebook summary injected into context. States:

1. **Scope & Plan** — from the question, emit a **plan artifact**: sub-questions / claims-to-establish + an initial outline + a soft effort budget (breadth → target search/fetch counts, à la "let the agent estimate effort"). Written to the notebook and surfaced (non-blocking) in the sheet.
2. **Gather** (iterative deepening) — pick the highest-value open gap → `WebSearch` → triage/dedup results → read via `FetchUrl` (headless; auto-escalates when needed) → optionally `SearchAcademic`/`SearchImages`/`HarvestImages`/`ExtractTable`/`ExtractDataText` → write findings (with provenance) to the notebook.
3. **Reflect / gap-analysis** — assess coverage vs. the plan ("which sub-questions are still thin or unsupported?"); choose the next gap or stop. This is the loop's convergence control (replaces "just keep going until the step budget").
4. **Synthesize (outline-first)** — draft the report from the outline + notebook findings; every claim ties to notebook finding(s); emit `[[n]]` citation sentinels (see §5.7) and embed selected images (see §5.6).
5. **Verify** — grounding + adversarial passes (see §5.5); fix/hedge/drop unsupported claims; append a compact **Verification** summary.

The existing `Checkpoint` auto-continue (`RESEARCH_MAX_AUTO_CONTINUES`) and `FINAL_CYCLE_NUDGE` still bound total work; the state machine is layered *inside* that budget, and a checkpoint serializes the notebook (§5.2) so a resumed task continues with structured state instead of re-reading history.

**Observability:** the existing single `research-task` trace stays; each state becomes a labeled span/generation so Langfuse shows plan/gather/reflect/synthesize/verify phases.

### 5.2 The Notebook — structured research memory (`src/data/researchTasks.ts` + a reducer module)

The long-horizon backbone. Replaces "grow the message array" with a compact, structured object persisted on the `ResearchTask`:

```ts
interface ResearchNotebook {
  plan: { subQuestions: string[]; outline: string[]; effortBudget?: { searches: number; fetches: number } }
  sources: ResearchSourceRec[]   // { id, url, title, credibilityHint?, fetchedVia: 'headless'|'tab', contentHash }
  findings: Finding[]            // { id, claim, sourceId, quote, confidence: 'high'|'med'|'low' }
  images: ResearchImage[]        // see §5.6
  coverage: Record<string /*subQuestion*/, { supported: boolean; gaps?: string }>
}
```

- **Context injection:** each state gets a *summarized* view of the notebook (plan + coverage + recent findings), not the whole thing, so context doesn't explode on big topics.
- **Persistence:** stored on `ResearchTask.notebook`, written through the existing panel relay + `applyUpdate` serialization. Keep it **compact and bounded** (cap findings/images counts and quote length) — it shares the ~10 MB `chrome.storage.local` namespace with settings/memory/conversations under `MAX_TASKS`/`pruneTasks`.
- **Pure reducers** (add/dedupe source, add finding, mark coverage, add image) live in a testable module → Vitest unit tests (dedupe by URL/`contentHash`, coverage transitions).

### 5.3 Expanded toolset (`src/tools/research.ts`)

All research tools stay **ungated** — read-only, web-egress-only, no user present in the offscreen sandbox (the documented exception alongside `Checkpoint`/`ToolSearch`/`GetTool`). The toolset is **all-active** (not progressively disclosed — the research loop calls `runAgentTurn` directly, outside `runTurnChain`'s disclosure); ~10 tools is within budget. Keep `RESEARCH_SYSTEM` in sync as tools are added.

| Tool | Status | Behavior |
|---|---|---|
| `WebSearch` | keep | DDG-lite (unchanged; a `SearchProvider` seam is optional, not required) |
| `FetchUrl` | **enhance** | Headless `fetch()` first; on JS/paywall/PDF signal or explicit `render:true`, request escalation via the SW broker (§5.4) and return rendered text (+ optional screenshot ref). Named `FetchUrl` (not `ReadPage`) to stay distinct from the foreground `ReadPage`, which reads the *user's current tab*. |
| `ExtractDataText` | keep | structured JSON from fetched text |
| `ExtractTable` | **new** | table-aware structured extraction (thin wrapper over `extractStructured` with a tabular prompt/schema) |
| `SearchAcademic` | **new** | keyless arXiv / Semantic Scholar / OpenAlex → `{title, abstract, authors, year, pdfUrl, sourceUrl}` |
| `SearchImages` | **new** | keyless Wikimedia Commons + Openverse → `{thumbUrl, fullUrl, title, sourcePageUrl, license, author, dims}` (§5.6) |
| `HarvestImages` | **new** | from a page already read/rendered, collect `<img>` `{src, alt/figcaption, dims, sourcePageUrl}` |
| `Notebook.read` / `Notebook.write` | **new (control)** | internal, ungated (like `Checkpoint`): record findings / read current coverage |

Vision-read of an image that *is* data (chart/diagram) reuses escalation + `vision.ts` (only when the model is image-capable; the probe caches this).

### 5.4 Service-worker tab-escalation broker (`src/background.ts`)

New `research.renderPage` request (offscreen → SW). The SW:

1. **Guards** the URL with `isFetchableUrl` (same SSRF guard as headless fetch) — refuse private/localhost/non-http.
2. Lazily opens **one isolated research tab** in a dedicated background window; navigates to the URL; waits for load/settle.
3. Injects page-control (reuse `domIndex` / an in-page readability extraction / `marks`) to return cleaned text; optionally `captureVisibleTab(windowId)` for a screenshot.
4. Returns `{ text, title, finalUrl, screenshotDataUrl? }` to offscreen.
5. **Mutex(1):** only one render at a time (fits the sequential model — no tab contention). Tear the tab/window down on idle.

**Security boundary (hard):** render is **read-only + safe, non-committing actions only** (navigate-to-requested-URL, scroll, expand "read more", dismiss cookie banners). **No** form submit, cross-origin navigation, or auth — there is no human at the point-of-no-return gate, so the broker must refuse them outright (it never routes through `requestApproval` because there's no UI in the offscreen path).

**Two open implementation risks to resolve in Phase 3 (spikes):**
- **Screenshot of a non-visible tab.** `captureVisibleTab` captures a *window's active tab*. Plan: give the research window its own tab as active and capture by `windowId` (works even when unfocused; minimized windows may fail on some platforms). Fallback: `chrome.debugger` `Page.captureScreenshot` (captures background tabs but shows a debugging banner and is heavier). Spike both; pick per-platform behavior.
- **Cookie/session isolation.** A real tab navigation rides the profile's cookie jar (unlike headless `fetch({credentials:'omit'})`), so it could read the user's logged-in content. **Preferred:** open the research window as **incognito** (`chrome.windows.create({incognito:true})`) for a clean jar — requires the extension be allowed in incognito (user toggle) and a manifest `"incognito"` mode. **Fallback:** a normal isolated window with the SSRF guard, documented as sharing the profile session. Expose a settings toggle ("Render hard pages in a private window") defaulting to incognito-when-available.

### 5.5 Verification subsystem

1. **Grounding check** — for each `[[n]]` in the draft, take the claim sentence + the cited source's stored quote/text and ask the model *"does this source support this claim? yes / partial / no, with the supporting quote."* Downgrade/flag/hedge unsupported claims. Cheap, high-value — kills hallucinated citations.
2. **Adversarial pass** — for the top-K load-bearing claims, a red-team prompt: *"find a reason this is wrong, outdated, or contradicted; search for a counter-source."* Mirrors the installed `deep-research` skill's adversarial verify.
3. **Output** — the report plus a compact **Verification** section: claims checked / confirmed / hedged / removed, and per-source credibility notes.

Verification is a bounded final phase (respects the effort budget); it runs on the notebook's findings, so it doesn't re-fetch everything.

### 5.6 Image modality — keyless, attribution-first

**Sourcing** (keyless): `SearchImages` (Wikimedia Commons + Openverse — both expose license/author/source), `HarvestImages` (from pages already cited — keyless by construction, best for charts/figures on escalated/rendered pages), and vision-read of chart-like images into findings.

**Notebook `images`:**
```ts
interface ResearchImage {
  id: string; url: string; sourceId: string   // ties to a notebook source
  caption?: string; license?: string; author?: string
  dims?: { w: number; h: number }; relevanceNote?: string; contentHash: string
}
```

**Embedding into the report** (the report card already flows through `splitBlocks`→`ImageCarousel`/`Markdown`, `src/ui/Chat.tsx:1693`):
- **Attribution-first embedding is inline `Markdown`** — `![caption](url)` followed by a source + license line — because attribution must be *visible*, and the current `ImageCarousel` renders bare `<img alt="">` with **no caption/attribution slot**. So the synthesis default is one image per figure with its caption/attribution beneath.
- **Carousels** stay available for optional galleries (≥2 consecutive bare image lines still group via `splitBlocks`), but only where per-image attribution isn't required — **or** we extend `ImageCarousel` with a caption/attribution overlay (small, in-scope in Phase 5). Pick the overlay extension if galleries turn out to be the common case.
- Dedupe by URL/`contentHash`. Broken images self-heal — `ImageCarousel`/`<img onError>` already drop them.

**Constraints:** prefer permissive sources and always attribute (keeps a "complete" report defensible); no data-URL caching (chrome.storage bloat); image *reading* needs a vision-capable model, but image *inclusion* works for any model.

### 5.7 Inline favicon citations (replacing `[n]`)

Keep in-text citations; swap the `[n]` glyph for an **inline favicon chip** linking to the source, reusing the chat's machinery: `faviconUrl()` (Chrome's on-device `/_favicon/` cache — no third-party service; `"favicon"` permission already granted) + `Favicon`/`SourceCard` hover card.

- **Citation model:** synthesis emits a **sentinel `[[n]]`** (double bracket) rather than `[n]`, mapping to `task.sources[n-1]`. The sentinel avoids false positives from literal `[1]` in quoted text. `RESEARCH_SYSTEM` updated to emit `[[n]]` and the trailing Sources list.
- **Render pass:** a **citation-rewrite** in the shared renderer replaces each `[[n]]` (and clusters like `[[1]][[2]]`) with a favicon chip / small overlapping favicon cluster (reusing `SourceBar`'s overlap style), each a link with the hover `SourceCard`.
- **Graceful degradation:** neutral-dot fallback when no favicon is cached (existing `.source-favicon-fallback`); the number stays as `aria-label`/tooltip; **copy-as-markdown converts `[[n]]`→`[n]`** so the plain-text report stays portable.
- **Refactor (in-scope):** lift `faviconUrl` + `Favicon` + `SourceCard` out of `Chat.tsx` into a shared `src/ui/sources.tsx` (or `citations.tsx`) module consumed by both the chat `SourceBar` and the report citations. The trailing Sources list stays (the n→URL map + accessible full list), now favicon-adorned.
- **Pure logic → Vitest:** the `[[n]]`-parse / cluster-grouping / copy-conversion functions are Chrome-independent and unit-tested.

### 5.8 UI (panel, non-blocking) (`src/ui/Chat.tsx` + `styles.css`)

- Research **sheet**: add a **Plan** block (sub-questions + outline, shown once the plan artifact exists) and a **coverage** indicator (per sub-question supported/gap). All non-blocking — fire-and-forget preserved.
- Research **report card**: add the **Verification** summary and per-source **credibility / "via tab"** markers; inline favicon citations and embedded images render through the existing shared block renderer.

## 6. Data-model & protocol changes

- `src/data/researchTasks.ts`: add `ResearchNotebook`, `ResearchSourceRec`, `Finding`, `ResearchImage`; add `notebook?: ResearchNotebook` to `ResearchTask`. Extend `ResearchStep.tool` union with the new tool names.
- New messages (§8): `research.renderPage` (offscreen→SW) and `research.renderResult` (SW→offscreen). Existing `ensureAndStart`/`start`/`update`/`done`/`error`/`cancel` unchanged.

## 7. Long-horizon integration

- **Checkpoint hand-off** serializes the notebook, so a resumed cycle continues with structured state (not a history re-read).
- **Effort budget** from the plan phase sets soft search/fetch ceilings; the reflect phase enforces convergence; `RESEARCH_MAX_AUTO_CONTINUES` + `FINAL_CYCLE_NUDGE` remain the hard backstop.

## 8. Message protocol (additions)

```ts
| { type: 'research.renderPage'; taskId: string; url: string; want: 'text' | 'screenshot' | 'both' }
| { type: 'research.renderResult'; taskId: string; text?: string; title?: string; finalUrl?: string; screenshotDataUrl?: string; error?: string }
```

The SW owns the render tab/window + mutex; offscreen awaits `renderResult` (correlated by `taskId`).

## 9. Security & privacy (consolidated)

- Tab render is **read-only + safe non-committing actions**; no submit/cross-origin-nav/auth (no human gate in the headless path).
- `isFetchableUrl` SSRF guard runs **before** any navigation, mirroring headless fetch.
- **Session isolation** via incognito research window when available (else documented fallback + settings toggle).
- Images embed by remote URL (no third-party favicon/image proxy; favicons stay on-device via `/_favicon/`).
- Observability redaction (`captureContent`/`captureScreenshots`) already gates whether page text/screenshots reach Langfuse — new spans honor it.

## 10. Build phasing (each phase ships independently)

1. **Phase 1 — Structured loop + notebook.** State machine, notebook + pure reducers (+ tests), reflection/gap loop, outline-first synthesis, checkpoint serialization, plan/coverage in the sheet. *No new external reach.* Pure workflow win, provider-agnostic, low risk.
2. **Phase 2 — Verification & grounding.** Grounding check + adversarial pass + Verification summary + `[[n]]` sentinel model.
3. **Phase 3 — Inline favicon citations.** Shared `sources`/`citations` module refactor, `[[n]]`→favicon render pass (+ tests), report-card wiring, copy-as-markdown conversion. *(Independent of the browsing tab work; can land before or after Phase 4.)*
4. **Phase 4 — Hybrid browsing escalation.** SW broker + isolated render tab/window + mutex + screenshot & isolation spikes; `FetchUrl` escalation; vision-read.
5. **Phase 5 — Modalities.** `SearchAcademic`, `SearchImages`, `HarvestImages`, `ExtractTable`; image embedding + attribution in the report; `blocks.ts` single-image/caption polish.

## 11. Testing & verification

- **Vitest (pure logic):** notebook reducers (dedupe/coverage), `[[n]]` citation parse/cluster/copy-conversion, DDG/academic/image response parsers, `blocks.ts` image handling. Co-locate as `*.test.ts` (matches `researchTasks.test.ts`, `webFetch.test.ts`, `toolDiscovery.test.ts`).
- **`/verify-extension` (Chrome-coupled, end-to-end):** run a research task against (a) a JS-heavy/SPA page → proves escalation renders content headless-fetch misses; (b) a topic with a checkable fact → proves grounding downgrades an unsupported claim; (c) an academic/PDF query → proves `SearchAcademic` + PDF read; (d) a visual topic → proves `SearchImages`/`HarvestImages` embed attributed images and favicon citations render.
- Confirm `npm run build` (tsc strict) clean after each phase; reload unpacked; watch Langfuse phase spans.

## 12. Risks & open issues

- **DDG-lite fragility remains** (retrieval descoped) — escalation mitigates *read* failures, not *search* failures. Residual; the optional `SearchProvider` seam is the future mitigation.
- **Screenshot of non-visible tab / cookie isolation** — the two Phase-4 spikes (§5.4); may constrain the vision-on-page feature per-platform.
- **Cost/latency** — verification + escalation + image search multiply model/tab calls; the plan-phase effort budget and bounded verification keep it in check.
- **Vision gating** — image reading needs an image-capable endpoint (`vision.ts` probe); text-only endpoints still get image inclusion + all text features.
- **chrome.storage size** — notebook + report + image metadata persist under the shared 10 MB / `MAX_TASKS` cap; keep the notebook compact and store image URLs (not bytes).
- **Prereq (now clear):** the `observability-langfuse` merge is resolved on `main@47e7055`; `research.ts` is conflict-free. Re-verify before implementation.
```
