# Progressive tool disclosure + read-tool consolidation — design

## Problem

Every agent turn hands the model the **entire** tool set. `Chat.tsx` calls
`createAgentTools(...)` and passes the whole `ToolSet` into `streamText({ tools })`
(`src/agent/agent.ts`). That set is **20 tools**:

```
ViewCurrentTab ViewOpenedTabs InspectPage RequestPageControl ControlPage
AutofillForm GetActiveTabDOM GetAllDOM NavigateTab ExtractData SaveMemory
SearchMemory GetBrowsingHistory GetBookmarks GetTopSites GetDownloads
ListAllSkills ReadSkill SaveSkill StartResearch
```

The only filtering (`src/tools/tools.ts`) is **static, config-time** — never
per-message:

- `tabAccess !== 'all-tabs'` drops `ViewOpenedTabs`, `GetAllDOM`
- an ungranted browsing permission drops the matching insight tool
- a per-tool `never` policy drops that tool

So a typical install (all-tabs + a couple of insights granted) ships **~18–20
verbose tool schemas on every message**, including turns that need no tools at
all ("hi", "explain closures"). That is roughly **3–4k tokens of tool
definitions per request**, constant, and it degrades selection: the more tools
in context, the more the model mis-selects, over-calls, or confuses
near-duplicates.

Three concrete faults:

1. **No per-message relevance.** Filtering is by *config*, never by *what the
   user asked*. The page-control cluster is present in a pure Q&A turn.
2. **Overlapping, confusable tools.** `ViewCurrentTab` vs `GetActiveTabDOM` vs
   `InspectPage`; `ViewOpenedTabs` vs `GetAllDOM`; four insight tools that
   differ only by data source. Near-duplicates are exactly what hurts selection.
3. **Skills already solved this; tools didn't inherit it.** Skills use real
   progressive disclosure (`Chat.tsx` builds a name+description catalog; `ReadSkill`
   loads the body on demand). Tools get no equivalent.

## Goals

- Cut per-message tool-definition tokens, especially on turns that need few or
  no tools.
- Improve tool-selection accuracy by shrinking the active set and removing
  confusable near-duplicates.
- Do it **without a pre-turn classifier LLM call** — must work against any
  OpenAI-compatible endpoint, including weak local models.
- Preserve every existing invariant: the `requestApproval` gate on each tool,
  the two-nested page-control gates, permission/visibility filtering, the
  set-of-marks vision path, and the marked-screenshot `imageQueue`.

## Non-goals

- No embeddings / vector search for tool retrieval (substring match is enough
  for ~14 tools).
- No change to how **skills** are discovered (the skills catalog stays in the
  system prompt; `ListAllSkills`/`ReadSkill` unchanged). Unifying tool and skill
  discovery is a possible future step, out of scope here.
- No merging of tools with distinct write/approval semantics (memory, skills,
  page control stay as separate verbs).

## Approach

Two independent, composable changes:

1. **Progressive disclosure** — the model sees only a tiny always-on core plus a
   catalog it can search; it *loads* the tools it needs, and loaded tools stay
   available for the rest of the turn. This is the Claude Code deferred-tools /
   `ToolSearch` pattern, and mirrors this app's own `ReadSkill` flow.
2. **Consolidation** — merge the three genuinely-overlapping *read* clusters into
   mode-parameterized tools (20 → 14 real tools). Verbs with distinct
   side-effects keep their own tools.

Confirmed decisions:

- **Always-on core:** `ToolSearch`, `GetTool`, `ReadPage`.
- **Merge depth:** read-overlaps only (`ReadPage`, `ReadTabs`, `QueryBrowserData`).
- **No extra LLM call.** The model does discovery itself in one round.

## The mechanism (activeTools + prepareStep)

The Vercel AI SDK v5 (`ai@5.0.210`) supports **`activeTools`** — a per-step
allow-list of tool names. `prepareStep` (already present in `runAgentTurn`,
`src/agent/agent.ts`) may return `{ activeTools }` for the step. Only active
tools' schemas are sent to the model that step; inactive-but-defined tools cost
nothing and cannot be called.

- Keep **one full `ToolSet`** defined (all real tools + the two meta-tools).
- Maintain a per-turn **mutable `activeNames: Set<string>`**, created in
  `Chat.tsx` and passed to both `createAgentTools` (so `GetTool` can mutate it)
  and `runAgentTurn` (so `prepareStep` can read it) — the exact pattern the
  existing `imageQueue` already uses.
- `prepareStep` returns `activeTools = [...ALWAYS_ON, ...activeNames]` every step,
  where `ALWAYS_ON = ['ToolSearch', 'GetTool', 'ReadPage']`.
- When the model calls `GetTool`, its `execute` adds the requested names to
  `activeNames`. The *next* step's `prepareStep` reads the grown set, so those
  tools become callable from then on. (Timing: `execute` runs during step N;
  `prepareStep` runs before step N+1 — the ordering is correct.)

`prepareStep` must merge with its existing job of draining `imageQueue`:

```ts
prepareStep: ({ messages }) => {
  const active = [...ALWAYS_ON, ...activeNames]           // always compute
  const queue = options.imageQueue
  if (queue && queue.length) {
    const injected = /* existing image-message mapping */
    return { activeTools: active, messages: [...messages, ...injected] }
  }
  return { activeTools: active }
}
```

### Example turn — "fill out this signup form"

```
step 0  active: ToolSearch, GetTool, ReadPage
        → model calls ToolSearch({ query: "form" })
step 1  result lists RequestPageControl, ControlPage, AutofillForm (+descriptions)
        → model calls GetTool(["RequestPageControl","ControlPage","AutofillForm"])
step 2+ those 3 are now active → model runs the flow (each still gated by approval)
```

For "what's a closure?" the model calls nothing — only the 3 always-on stubs are
ever in context.

## The two meta-tools

Both are **ungated** (no `requestApproval`) and **not** in `TOOL_CATALOG` — they
are internal plumbing that touches no page, network, or user data, analogous to
today's `always`-policy `ListAllSkills`. They are always in `ALWAYS_ON`.

### `ToolSearch({ query? })`

- Returns `{ tools: [{ name, description }] }` from the **permission-filtered
  catalog** (see below). `query` does a case-insensitive substring match over
  name + description; omitting it returns the whole catalog.
- Does **not** activate anything. Discovery only.
- Excludes the meta-tools and any tool already in `activeNames` (optional: mark
  already-loaded ones so the model doesn't re-load).

### `GetTool({ names: string[] })`

- Validates each name against the catalog. Unknown or filtered-out names come
  back as a correctable error string (like the existing skill-name errors),
  **not** a denial, so the model can retry with a corrected name.
- Adds valid names to `activeNames` and returns a short ack, e.g.
  `{ loaded: ["RequestPageControl","ControlPage"], note: "These tools are now available." }`.
- Does not need to echo the schemas — `activeTools` exposes them automatically on
  the next step.

### The catalog

`createAgentTools` already builds the full `tools` object and performs all the
deletion-based filtering (tabAccess, granted permissions, `never` policy). After
that filtering, derive the catalog from the surviving entries:

```ts
const catalog = Object.entries(tools)
  .filter(([name]) => !META.has(name))
  .map(([name, t]) => ({ name, description: t.description ?? '' }))
```

`ToolSearch` and `GetTool` close over `catalog` and `activeNames`. Because the
catalog is derived *after* filtering, a `never` / ungranted / active-tab-hidden
tool never appears in search and cannot be loaded — the existing security model
is preserved exactly.

## Always-on core & turn-conditional activation

`ALWAYS_ON = ['ToolSearch', 'GetTool', 'ReadPage']` — so "read/summarize this
page" stays a **1-step** action with no discovery round-trip.

To avoid dead discovery round-trips when context already implies a cluster,
seed `activeNames` at turn start (in `Chat.tsx`) and let one tool self-expand:

- **Open page-control session** (continuing across turns): seed `activeNames`
  with `RequestPageControl`, `ControlPage`, `AutofillForm`.
- **`@memory` used this turn**: seed `activeNames` with `SearchMemory` (the turn
  already pre-authorizes it via `turnAllowed`).
- **`RequestPageControl` granted mid-turn**: its `execute` adds `ControlPage`
  and `AutofillForm` to `activeNames` on success, so the model doesn't need a
  second `GetTool` for them.

All conditional logic lives where the context exists (`Chat.tsx` /
`RequestPageControl.execute`); `prepareStep` stays dumb — it only reads the set.

## Consolidation (20 → 14 real tools)

Merge only the overlapping **read** clusters. Each merged tool keeps the full
behavior of what it replaces, selected by a `mode`/`source` discriminator.

| New tool | Replaces | Shape |
|----------|----------|-------|
| `ReadPage` | `ViewCurrentTab` + `GetActiveTabDOM` + `InspectPage` | `{ mode: 'text' \| 'dom' \| 'elements', reason }` |
| `ReadTabs` | `ViewOpenedTabs` + `GetAllDOM` | `{ tabIds?: number[], mode: 'text' \| 'dom', reason }` |
| `QueryBrowserData` | `GetBrowsingHistory` + `GetBookmarks` + `GetTopSites` + `GetDownloads` | `{ source: 'history' \| 'bookmarks' \| 'topSites' \| 'downloads', query?, sinceDays?, state?, maxResults? }` |

**Unchanged** (11 tools): `RequestPageControl`, `ControlPage`, `AutofillForm`,
`NavigateTab`, `ExtractData`, `SaveMemory`, `SearchMemory`, `ListAllSkills`,
`ReadSkill`, `SaveSkill`, `StartResearch`.

Result: **14 real tools** + **2 meta-tools** defined; **3** active by default.

### `ReadPage` details

- `mode: 'text'` → today's `ViewCurrentTab` path (`readTabContent`), approval
  summary "View the tab you are currently on".
- `mode: 'dom'` → today's `GetActiveTabDOM` path (`readTabDom`, `MAX_DOM_CHARS`),
  summary "Read the DOM/HTML structure of the tab you are on".
- `mode: 'elements'` → today's `InspectPage` path **verbatim**: the
  session/approval short-circuit (no card if a page-control session owns the
  tab), `mountPresence`, mid-session `setTint`, `snapshotPage`, and the
  `lookResult` set-of-marks vision capture that pushes onto `imageQueue`. This is
  the most delicate merge — preserve it exactly, only re-homed under a `mode`
  branch.
- Approval summary and card copy vary by `mode`.

### `ReadTabs` details

- `mode: 'text'` → `ViewOpenedTabs`; `mode: 'dom'` → `GetAllDOM`.
- No `tabIds` → list open tabs only (summary "See the list of your open tabs").
- With `tabIds` → read each at the mode's char cap (`readTabContent` /
  `readTabDom(..., MAX_DOM_CHARS_PER_TAB)`).
- Removed entirely in `active-tab` mode (replacing today's deletion of
  `ViewOpenedTabs` + `GetAllDOM`).

### `QueryBrowserData` details

- One tool, `source` discriminator. Per-source Chrome-permission gating is
  preserved: at build time, `QueryBrowserData` is included only if **at least
  one** of `history/bookmarks/topSites/downloads` is granted, and its `execute`
  rejects a `source` whose permission is not granted (correctable error). The
  catalog description should name which sources are currently available so the
  model doesn't request an ungranted one.
- Optional refinement: the input schema's `source` enum can be narrowed to the
  granted set at build time.

## Filtering & gating — unchanged guarantees

- `requestApproval` still wraps every real tool's `execute`. `ToolSearch` /
  `GetTool` are the only ungated additions and touch nothing sensitive.
- Point-of-no-return page-control steps still raise their one-shot cards.
- The catalog is derived after all deletions, so `never` / ungranted /
  active-tab-hidden tools are invisible to discovery and unloadable.
- A hallucinated call to an inactive tool yields `NoSuchToolError`; the existing
  `experimental_repairToolCall` already returns `null` for that case
  (`agent.ts`), surfacing a benign error card — the model then discovers
  properly. System-prompt guidance (below) minimizes this.

## System prompt changes

Replace the long per-tool enumeration in `DEFAULT_SYSTEM_PROMPT`
(`src/data/settings.ts`) with a short capability overview + the disclosure
protocol. Approximate shape:

> You have tools available on demand, across these capabilities: reading the
> current page, reading other tabs, controlling a page (click/type/fill),
> navigating tabs, extracting structured data, long-term memory, browsing
> insights (history/bookmarks/top sites/downloads), and background research.
> They are **not loaded** by default. To use one: call `ToolSearch` to list
> what's available (optionally with a query), then `GetTool` with the names you
> need — loaded tools stay available for the rest of this turn. `ReadPage` is
> always available for the current tab. If the message needs no tools, just
> answer.

Keep the existing `@mention` / `@memory` / skills / "never fabricate page
content" guidance. `accessNote`, `browsingInsightsNote`, memory context, and the
skills catalog append as they do today. `MAX_STEPS = 24` easily absorbs the
extra 1–2 discovery steps.

## Settings / permission-matrix changes

`src/data/settings.ts` `TOOL_CATALOG` rows change to match the merged names:

- `reading` group: replace `ViewCurrentTab`, `ViewOpenedTabs`, `InspectPage`,
  `GetActiveTabDOM`, `GetAllDOM` with `ReadPage` and `ReadTabs`. Keep
  `ExtractData`, `StartResearch`.
- `insights` group: replace the four insight rows with a single
  `QueryBrowserData` row (Chrome permission grants remain the real per-source
  gate).
- Meta-tools are **not** added to the catalog.

**Migration:** `settings.toolPolicies` is a sparse map keyed by name. Old keys
(`ViewCurrentTab`, …) become inert; new tools fall back to their default (`ask`).
A user who had set an old tool to `never` must re-set it on the merged tool.
Acceptable for this project; note it in the changelog. `PermissionsTab` and the
tools quick-menu re-derive from `TOOL_CATALOG`, so both update automatically.

## Files touched

- `src/tools/tools.ts` — add `ReadPage`, `ReadTabs`, `QueryBrowserData`; remove
  the five merged read tools and four insight tools; add `ToolSearch` + `GetTool`
  meta-tools + catalog derivation; accept `activeNames` param; `RequestPageControl`
  self-expands the control cluster.
- `src/agent/agent.ts` — `runAgentTurn` accepts `activeNames`; `prepareStep`
  returns `activeTools` (merged with the existing image injection).
- `src/ui/Chat.tsx` — create `activeNames` per turn, seed conditional tools,
  pass to `createAgentTools` and `runAgentTurn`.
- `src/data/settings.ts` — `TOOL_CATALOG` rows; `DEFAULT_SYSTEM_PROMPT` rewrite.
- `README.md` / `CLAUDE.md` — update the tool list and note the disclosure model
  and the "new tools route through `requestApproval` **and** are discoverable via
  the catalog" invariant.

## Verification

No test suite. Per `/verify-extension`: `npm run build`, reload the unpacked
extension, then exercise:

1. **No-tool turn** — "explain closures" → model answers, calls nothing; confirm
   only 3 tools were ever active (log `activeTools` in `prepareStep` during dev).
2. **1-step read** — "summarize this page" → `ReadPage({mode:'text'})` directly,
   no discovery round-trip.
3. **Discovery → control** — "fill this form" → `ToolSearch` → `GetTool` →
   `RequestPageControl` (session card) → `ControlPage` steps (point-of-no-return
   cards still fire).
4. **Insights** — with only history granted, `ToolSearch` shows
   `QueryBrowserData` and the catalog names history only; `GetTool` +
   `QueryBrowserData({source:'bookmarks'})` returns a correctable error.
5. **active-tab mode** — `ReadTabs` absent from the catalog; `ReadPage` present.
6. **@memory** — `SearchMemory` pre-seeded active, no discovery needed.
7. **Vision path** — on a vision model, `ReadPage({mode:'elements'})` still
   captures the set-of-marks screenshot and the presence overlay behaves.

## Risks & mitigations

- **Model doesn't discover, tries to answer about a page without reading.**
  Mitigation: `ReadPage` always-on covers the most common case; prompt is
  explicit about the protocol; `NoSuchToolError` repair is benign.
- **`ReadPage({mode:'elements'})` regression** (the vision/presence path is
  subtle). Mitigation: port `InspectPage` logic verbatim under the branch; item
  7 in verification targets it.
- **Weak models loop on ToolSearch/GetTool.** Mitigation: seed conditional
  clusters; `GetTool` errors are correctable, not fatal; `MAX_STEPS` bounds it.
- **Permission-policy migration surprises** a user who set an old tool to
  `never`. Mitigation: documented; small user base.

## Rollout

Single change set (no flag) given the small install base and the
`/verify-extension` gate. If desired, `ALWAYS_ON` could later be made
configurable, but not in this iteration (YAGNI).
