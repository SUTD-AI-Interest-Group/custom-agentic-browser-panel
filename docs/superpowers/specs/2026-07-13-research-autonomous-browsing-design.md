# Autonomous background-tab browsing for the research agent

**Date:** 2026-07-13
**Status:** Approved

## Problem

Two complaints, one root cause each.

**The research agent only searches.** It runs `WebSearch` over and over and rarely
lands a source. When `fetchReadable` hits a 403 / Cloudflare wall / non-HTML
content-type it returns a bare error, the model shrugs, and runs another search.
Sources are only recorded on a *successful* fetch, so a run against a hostile web
produces a wall of search rows and almost no findings.

**It surfaces neither reasoning nor findings.**

- `stepsOf()` (`src/agent/research.ts:133`) filters the turn's parts to
  `p.type === 'tool'` and discards every `text` part. The model's reasoning
  between calls is generated, then dropped on the floor.
- `ResearchSheet` (`src/ui/Chat.tsx:2352`) renders the plan, the tool rows, and
  "Sources so far" — but never `notebook.findings`. The actual research content is
  recorded, streamed to the panel, and then not drawn.

**Autonomous browsing does not exist today.** `src/platform/researchRender.ts` is a
*one-shot render*: open an isolated window, navigate, scroll to bottom once,
extract readable text, optionally screenshot, return. It cannot click, type,
expand, or paginate. And it is not a tool — it is an escalation hidden inside
`FetchUrl`, firing only when the plain fetch errors or returns < 400 chars. The
model has no "go open that page and look around" affordance at all.

## Design

### Action surface

The tab runs headless, in incognito, with no user present — there is no human at
the approval gate, so whatever we allow, it does unsupervised. The allowed surface
is **read + navigate + site-search**:

- Scroll, click links (including cross-origin, SSRF-checked), click
  expanders/accordions/"show more", click pagination.
- Type into a *search-shaped* input and press Enter.
- Denied: password/payment/sensitive fields, any non-search form submit, anything
  auth- or purchase-shaped.

Incognito means logged-out, so nothing destructive is reachable; site-search is
where the value is when DuckDuckGo 403s or a site's own index beats it.

### Components

**`src/platform/researchTab.ts` (new)** — owns the isolated window/tab lifecycle
extracted from `researchRender.ts`: incognito-preferred window, the mutex, idle
teardown. `researchRender.ts` becomes just the one-shot render on top of it, and a
browse session sits alongside as a second consumer. One window, one page at a
time, one cookie jar to reason about.

A browse session **holds the mutex for its whole life** so a concurrent `FetchUrl`
escalation cannot navigate the tab out from under it, bounded by a step budget
*and* a wall-clock timeout so it cannot deadlock the renderer.

The SW also records the render window id in `chrome.storage.session` and closes any
leftover window on startup. `researchRender.ts` already documents this orphan leak;
a session that holds the tab for minutes makes it much likelier to bite.

**`src/platform/researchBrowse.ts` (new)** — the SW-side session over the held tab:
`open(url)`, `observe()` → `snapshotPage(tabId)`, `act(action)` → dispatch to
`pageActions` + `waitForStable`, `close()`. Every `act` is checked by the policy
below first.

**Protocol** — a new `research.browse` / `research.browseResult` message pair in
`src/data/researchTasks.ts`, mirroring the existing `renderPage`/`renderResult`
correlation-id pattern (`src/background/offscreen.ts:15`): same pending-map,
timeout, and abort wiring. Model loop stays in offscreen; tab driving stays in the
SW.

**`src/tools/browsePolicy.ts` (new)** — a **pure** classifier,
`isSafeResearchAction(action, element) → {ok} | {ok: false, reason}`, unit-testable
without Chrome (as `toolDiscovery` and `webFetch` are). This is what enforces the
action surface, and it is the safety-critical piece:

- **click** — deny if `element.sensitive`; deny if it is a submit control inside a
  `method=post` form that is not a search form; deny if the accessible name is
  purchase/auth/destructive-shaped (`buy`, `checkout`, `subscribe`, `sign up`,
  `log in`, `delete`, …). Allow links, tabs, accordions, "show more", pagination.
- **type** — allow *only* into a search-shaped input (`type=search`,
  `role=searchbox`, or an accessible name matching `search|query|filter|find`).
  Everything else denied — this is what keeps "site-search" from quietly becoming
  "fill out any form".
- **press** — `Enter` only, and only on a search-shaped input.
- **navigate / scroll / back** — allowed; navigate is http(s)-only through the
  existing `isFetchableUrl` SSRF guard.

Requires one additive field on `IndexedElement`: `formMethod?: string` (the closest
ancestor form's method), captured in the injected walker. Policy stays in the pure
module; the walker only reports raw DOM facts. The field is optional, so foreground
page control is unaffected.

**`src/agent/browseAgent.ts` (new)** — the nested sub-agent.
`runBrowseSession({ url, objective, broker, model, notebook, onStep })` runs a
`runAgentTurn` in its **own context** with a narrow toolset (Observe, Click, Type,
Scroll, Back, ReadPage, `Notebook.write`, Done) over the broker. It writes findings
straight into the **shared notebook** with the real source URL and quote as it goes
— nothing is lost through the digest — and returns `{ visited, digest,
findingsAdded }` to the gather agent.

Perception is **text-only indexed DOM**: each `observe` returns title, readable
text, and the numbered interactive elements from `domIndex.ts`. No screenshots —
works on every model regardless of vision support, and cheap per step.

Budgets: 12 steps, 120s wall-clock, and a per-task cap of 6 sessions so a runaway
cannot surf all night.

### Wiring to the 403 case

`BrowseSite({url, objective})` joins `createResearchTools()`, ungated like the rest.
`FetchUrl`'s hard-failure path returns a hint rather than a bare error:

```
{ error: 'fetch failed: HTTP 403',
  hint: 'This page blocked a plain fetch. Call BrowseSite({url, objective}) to open it in a real browser tab and read it.' }
```

Deliberately a *hint the model acts on* rather than a silent auto-escalation: a
`BrowseSite` call shows up in the step log, and invisibility is the other half of
the problem. The existing thin-text auto-render stays — it works and it is cheap.

### Surfacing

- **Reasoning** — `stepsOf()` stops discarding `text` parts, mapping them to steps
  with `kind: 'thought'`, interleaved in call order. `ResearchStep` gains `kind` and
  `depth`.
- **Findings** — `ResearchSheet` gets a Findings section rendering
  `notebook.findings` (claim, source chip, quote), live as they accumulate.
- **Browse steps** — the sub-agent's `onStep` emits into the same log at `depth: 1`,
  indented under its `BrowseSite` row, so the user can watch it surf.

## Verification

- `src/tools/browsePolicy.test.ts` — every deny case above. The important one.
- `src/agent/browseAgent.test.ts` — the loop against a fake broker + scripted model:
  budget stops, notebook writes, denied actions surface as tool errors.
- End-to-end via `/verify-extension` against a site known to 403 a plain fetch.

## Rejected alternatives

- **Flat browse verbs on the gather agent** (OpenTab/ClickIdx/…): every `observe`
  dumps a page's indexed elements into the gather agent's context, so a couple of
  pages blow the round's context and step budget. The notebook exists precisely to
  keep that context bounded.
- **Full `pageActions` parity with no gate**: silently drops the point-of-no-return
  protection the foreground has, relying on the incognito sandbox alone.
- **Set-of-marks screenshot perception**: costs a capture + image tokens every step,
  needs the window un-minimized each time (`researchRender.ts:133`), and degrades to
  nothing on non-vision models.
