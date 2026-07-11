# Auto-research + browser-use hardening — design

**Date:** 2026-07-11
**Status:** Approved (design); implementation plan to follow.
**Scope:** Features #1 (web search + fetch), #3 (structured extraction), #5 (background
research sub-agent), #7 (form autofill from memory), #8 (wait-for page stability) from the
capability review.

## Goal

Give the agent a real **auto-research** capability (search → fetch → extract → synthesize a
cited report, running as a genuine background task that survives the side panel closing) and
**harden the existing browser-use loop** (wait for async pages to settle; fill forms from
remembered profile data). Everything stays client-side, provider-agnostic (OpenAI-compatible),
and inside the existing `requestApproval` security model.

## The load-bearing insight: two clean halves

The work divides into two subsystems that share almost nothing, which is what keeps it safe:

- **Auto-research (#1, #3, #5) is headless.** It never touches the user's tabs. Its only
  capabilities are `fetch` (DuckDuckGo + arbitrary URLs) and `DOMParser` (HTML → text). It runs
  in an **offscreen document**, whose available surface is *exactly* Web APIs + `chrome.runtime`
  messaging — and crucially **not** `chrome.tabs`/`chrome.scripting`. So by construction the
  research agent cannot read the user's tabs, cookies, or drive pages.
- **Browser-use hardening (#7, #8) is foreground.** It needs `chrome.scripting.executeScript`
  on a live tab, which only the panel/service worker can do, so it stays in the existing
  `ControlSession` loop.

This split is also the security story: **the background research agent is a read-only,
web-egress-only sandbox** — no user-data tools, no page control, no memory writes. That is why
its *internal* steps do not each raise an approval card; only the foreground `StartResearch`
tool that launches it is gated.

## MV3 execution model (why offscreen, not the bare service worker)

The user chose "true background in the service worker." The correct MV3 mechanism to honor that
is an **offscreen document**: the service worker itself is ephemeral (killed after ~30s idle,
5-min hard cap) and cannot host a long-running agent loop, but an offscreen document runs its
own event loop independently and is not subject to that kill. So:

- **Service worker = orchestration + all `chrome.*` work.** Creates/closes the offscreen doc,
  reads settings from `chrome.storage`, persists task state, fires `chrome.notifications`.
- **Offscreen document = the research loop.** `fetch`, `DOMParser`, and the model API calls
  (also `fetch` under the hood). Holds **no** `chrome.*` state.

### Hard constraints from the Chrome Extensions MV3 rules

These are corrections applied during design review and MUST be honored in implementation:

1. **Offscreen has no `chrome.storage`.** Available surface = `chrome.runtime.sendMessage` /
   `onMessage`, `chrome.runtime.getURL`, and standard Web APIs only. Therefore the SW reads the
   provider config + model id and **passes them into the offscreen doc in the start message**;
   results flow back out via messaging; `researchTasks.ts` persistence runs in SW/panel only.
2. **Manifest gains two permissions:** `"offscreen"` and `"notifications"`. Without them the
   APIs are `undefined`.
3. **No icon files exist** in `public/`, so `chrome.notifications.create()` cannot reference a
   file path (would fail "Unable to download all specified images"). The completion notification
   **generates its icon as a data URL at runtime via `OffscreenCanvas` in the SW.**
4. **Offscreen is a singleton and needs state-locking.** Guard `createDocument()` against
   concurrent `StartResearch` calls racing two creations. The single document **multiplexes
   multiple research tasks** keyed by `taskId` in its own in-memory map — concurrency does not
   require a second document.
   *As built:* the `chrome.storage.session` lock originally specified here is a non-atomic
   check-then-act (verified in review to let 4/5 concurrent calls throw "single offscreen
   document"), so it was replaced with a **module-scope promise gate** — `let creatingOffscreen:
   Promise<void> | null`, assigned synchronously before any `await`, cleared in `.finally` — plus
   `hasDocument()`. The gate is a resource-creation mutex (same category as the existing
   `openPanels` Map), not persisted task state, and self-heals on SW restart.
5. **The SW stores zero state in variables.** All research-task state lives in
   `chrome.storage.local`; every message handler re-reads it. (The pre-existing `openPanels` Map
   for the close-panel feature is unaffected.)
6. **Transport is a broadcast, not a hand-rolled relay.** `chrome.runtime.sendMessage` from the
   offscreen doc reaches **both** the SW and the open panel. The panel renders updates live; the
   SW persists + notifies. Async `onMessage` handlers `return true`.
7. **`ExtractData` never `eval`s a schema (CSP).** It builds the validator from the caller's JSON
   schema declaratively via the AI SDK `jsonSchema()` helper.
8. **Vite gains a third entry:** `offscreen.html` (repo root, like `sidepanel.html`) →
   `src/background/offscreen.ts`, loaded via a module `<script src>` (no inline scripts).

## Architecture & new/edited files

```
public/manifest.json              (edit) add "offscreen" + "notifications" permissions
offscreen.html                    (new)  offscreen doc shell; <script src> to the host module
vite.config.ts                    (edit) add offscreen.html entry
src/background/offscreen.ts       (new)  research host: runResearch loop + WebSearch/FetchUrl/ExtractData; Web APIs + chrome.runtime only
src/background.ts                 (edit) orchestration: ensure/close offscreen doc (locked), relay-persist research.update/done, fire notifications (data-URL icon)
src/agent/research.ts             (new)  research agent: system prompt (plan→search→fetch→extract→synthesize w/ citations) + headless toolset + loop; reuses createModel + runAgentTurn
src/tools/research.ts             (new)  StartResearch (foreground, gated) + research tool defs (WebSearch, FetchUrl)
src/data/researchTasks.ts         (new)  research-task state persisted to chrome.storage.local (SW/panel context)
src/platform/webFetch.ts          (new)  research fetch helpers: DuckDuckGo lite search parse + FetchUrl HTML→text (offscreen)
src/platform/pageActions.ts       (edit) waitForStable() injected async fn: MutationObserver quiet-period + optional selector wait, bounded timeout   [#8]
src/tools/pageControl.ts          (edit) 'wait' ControlAction; runControlStep auto-waits (replaces the hardcoded 600ms setTimeout)                     [#8]
src/tools/tools.ts                (edit) register ExtractData (active tab) + AutofillForm [#7] + StartResearch; wire toolsets
src/data/memory.ts                (edit) add 'profile' memory kind [#7]
src/ui/Chat.tsx                   (edit) ResearchTask live card; chrome.runtime.onMessage listener for research.update/done; render final report + sources
src/ui/Settings.tsx / Memory.tsx  (edit, optional) surface 'profile' memories for user edit
```

## The five features

### #1 — WebSearch + FetchUrl (research toolset, offscreen)

- `WebSearch(query, maxResults?)` → `fetch` `lite.duckduckgo.com/lite` (simplest, most stable
  markup), parse result rows with `DOMParser` → `[{ title, url, snippet }]`. Retry with backoff
  on rate-limit/non-200; on repeated failure return a *tool error the agent can react to*
  (re-query) rather than throwing — a search miss must not crash the run.
- `FetchUrl(url)` → `fetch` (`credentials: 'omit'`, timeout via `AbortSignal.timeout`, size cap,
  HTML/text content-type guard, SSRF guard rejecting `localhost`/private-IP/non-http(s)), then
  `DOMParser` → strip `script`/`style`/`nav`/`footer`, prefer `<main>`/`<article>` text, cap
  length. Returns readable text + resolved final URL for citation.

### #3 — ExtractData (both toolsets)

- `ExtractData({ schema, source?, instruction })`: runs AI SDK `generateObject` against provided
  text (research) or the active-tab snapshot (foreground). `schema` is a JSON schema fed through
  `jsonSchema()` — never eval'd. Fallback for endpoints lacking structured-output: prompt-for-JSON
  + parse/repair, mirroring the existing `experimental_repairToolCall` pattern in `agent.ts`.
- Single-document by design (YAGNI). Multi-page extraction is the research *loop* iterating
  `FetchUrl` + `ExtractData`, not a tool responsibility.

### #5 — Background research sub-agent (SW + offscreen)

Flow:

1. Panel: main agent calls **`StartResearch(question)`** → **`requestApproval` card** (foreground
   gate; the one human-in-the-loop point).
2. SW: acquire the offscreen lock (`chrome.storage.session`), ensure the singleton offscreen doc
   exists, read provider config + model id from `chrome.storage`, send
   `{ type:'research.start', taskId, question, providerConfig, modelId }` to the doc.
3. Offscreen: `runResearch` loops plan → search → fetch/read → extract → synthesize *with
   citations* under a step/fetch budget, broadcasting `research.update` messages.
4. Panel (if open) renders a live **ResearchTask card**; SW persists each update to
   `chrome.storage.local`.
5. On completion the doc broadcasts `research.done`; the SW persists the final report and fires a
   `chrome.notifications` ping (runtime data-URL icon). If the panel was closed, the report is
   read from storage on next open. *As built:* the offscreen doc is **kept alive and reused**
   across tasks rather than closed per-task — it is one lightweight document with no security
   decay over time, and reusing it avoids a close/recreate race for negligible resource benefit.
6. Cancel: panel → SW → `research.cancel{taskId}` → doc aborts that task's `AbortController`.

### #7 — AutofillForm (foreground control session)

- `AutofillForm(...)` runs inside a granted `ControlSession`. Reads `profile`-kind memories,
  maps them onto the indexed form fields (model judgment), fills non-sensitive fields via the
  existing `typeIntoElement`/`selectOption` injections.
- **Sensitive fields (passwords/OTP/payment) and the final submit still fire the
  point-of-no-return card** (`isPointOfNoReturn` already flags these). Never fills a password/OTP
  from memory. Reports which fields it filled.

### #8 — WaitFor page stability (control loop)

- `waitForStable(tabId, { selector?, timeoutMs })`: an injected **async** function that resolves
  on a `MutationObserver` quiet period *or* when a target element appears, bounded by a timeout
  (a never-quiet page — ads/polling — simply proceeds after the timeout). Event-driven, no busy
  loop; self-contained per the injection rules in CLAUDE.md.
- `runControlStep` calls it after click/navigate/select, **replacing the hardcoded 600ms
  `setTimeout`**. Also exposed as an explicit `ControlPage` `wait` action for the model to use
  deliberately.

## Error handling & hardening

- **DuckDuckGo fragility:** prefer `lite`, retry with backoff, degrade to a recoverable tool error.
- **Fetch safety:** `credentials: 'omit'` (never ride the user's logged-in cookies), per-URL
  timeout, size cap, content-type guard, **SSRF guard** (reject localhost/private-IP/non-http(s)),
  per-run fetch budget.
- **Offscreen lifecycle:** `hasDocument()` + a module-scope promise gate (as built; see #4);
  one long-lived doc, reused across tasks, multiplexing tasks by `taskId`.
- **SW killed mid-task:** incremental persistence to `chrome.storage.local`; the offscreen→SW
  `done` message wakes the SW to notify; panel reads persisted result on open.
- **Trust boundary:** background research has no user-data/tab/memory-write tools — the documented
  reason its internal steps aren't individually gated. `StartResearch` itself is foreground-gated.
- **`#8` wait:** bounded timeout so a never-stable page cannot hang the control loop.
- **`#7` autofill:** sensitive/submit gated; no secrets filled from memory; shows what was filled.

## Verification (no test suite → `/verify-extension`)

Manual scripts per feature, plus `npm run build` (typecheck):

- **#1:** `WebSearch` returns rows for a query; `FetchUrl` returns readable text for a known page;
  SSRF guard rejects `http://localhost`.
- **#3:** `ExtractData` pulls a known page into a supplied schema; fallback path works on a
  non-structured-output endpoint.
- **#5:** start a research task, **close the panel**, confirm the completion **notification** fires
  and the **persisted report** is present on reopen; cancel mid-run aborts cleanly.
- **#7:** autofill a demo form; confirm non-sensitive fields fill and the **sensitive-field card
  fires** before a password/submit.
- **#8:** wait-for settles on a deliberately slow SPA; a never-quiet page proceeds after timeout.

## Build order (one spec, phased implementation)

1. **Browser-use hardening** — #8 `waitForStable` + #3 `ExtractData` (active tab). Lowest risk,
   no new infra, immediately useful.
2. **Research primitives, headless** — `WebSearch` + `FetchUrl` + `ExtractData` (fetched text),
   validated **in-panel first** to de-risk before adding background plumbing.
3. **Background infra** — manifest permissions + `offscreen.html`/`offscreen.ts` + Vite entry +
   SW orchestration (locked singleton, data-URL notification) + `StartResearch` + `researchTasks`
   persistence + ResearchTask card + broadcast messaging.
4. **Form autofill** — `profile` memory kind + `AutofillForm`.

## Out of scope (YAGNI)

- Chrome Web Store metadata / permission justifications / privacy policy (personal unpacked build;
  no publishing).
- Pluggable/paid search-provider APIs and Settings surface (keyless DuckDuckGo only).
- Multi-page crawl as a single tool (the research loop iterates instead).
- Structured/dedicated profile store + editor UI (reuse memory with a `profile` kind).
- Moving browser-use (page control) into the background (it stays foreground by necessity).
```