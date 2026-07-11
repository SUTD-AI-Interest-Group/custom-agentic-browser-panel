# Progressive Tool Disclosure + Read-Tool Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop shipping all ~20 tool schemas every turn — consolidate the overlapping read tools and expose the rest through a `ToolSearch`/`GetTool` catalog the model loads on demand, so a typical turn carries only 3 always-on tools.

**Architecture:** Keep one full `ToolSet` defined, but restrict what the model *sees* each step via the AI SDK v7 `activeTools` value returned from `prepareStep`. A per-turn mutable `activeNames: Set<string>` (mirroring the existing `imageQueue`) holds the always-on core (`ToolSearch`, `GetTool`, `ReadPage`) plus whatever the model loads via `GetTool` or the app seeds from context. Pure discovery logic lives in a new, unit-tested `src/tools/toolDiscovery.ts`; Chrome-coupled tool bodies stay in `tools.ts` and are verified via `/verify-extension`.

**Tech Stack:** TypeScript (strict), React 18, Vite 6, Vercel AI SDK v7 (`ai@7.0.22`), `@ai-sdk/openai-compatible@3.0.7`, Zod 3, Vitest, Chrome Extension MV3.

## Global Constraints

- **AI SDK is v7** (`ai@7.0.22`). `activeTools` is a valid `prepareStep` return; `system`→`instructions`, `repairToolCall` (not `experimental_`), `result.stream`, `result.responseMessages`, image parts as `{ type:'file', mediaType:'image', data }` — all already applied in `agent.ts`. Do not reintroduce v5 names.
- **Every real agent tool must route through the `requestApproval` gate** before its `execute()` proceeds. The only ungated additions permitted are the meta-tools `ToolSearch` and `GetTool` (they touch no page/network/user data).
- **Code style:** no semicolons (ASI), single quotes, 2-space indent, `interface` for object shapes / `type` for unions, `/** */` on exported symbols.
- **No build-time secrets; no backend.** Everything runs client-side.
- **Injected page functions must stay self-contained** (no closures over outer scope) — not touched by this plan, but do not break it.
- **Verify every task:** `npm run typecheck` must pass; for tasks with runtime surface, `npm run build` then reload the unpacked `dist/` in `chrome://extensions` and exercise the flow (the `/verify-extension` skill).
- **Commit after each task.** Scope commits with a pathspec (parallel sessions run on this repo).

**Tool inventory after this plan (14 real + 2 meta):** `ReadPage`, `ReadTabs`, `QueryBrowserData`, `RequestPageControl`, `ControlPage`, `AutofillForm`, `NavigateTab`, `ExtractData`, `SaveMemory`, `SearchMemory`, `ListAllSkills`, `ReadSkill`, `SaveSkill`, `StartResearch`, + meta `ToolSearch`, `GetTool`. Always-on core: `ToolSearch`, `GetTool`, `ReadPage`.

---

## File Structure

- **Create** `src/tools/toolDiscovery.ts` — pure discovery logic + constants (no Chrome/AI-SDK imports). Responsibility: catalog shape, search, name validation, active-set resolution.
- **Create** `src/tools/toolDiscovery.test.ts` — Vitest unit tests for the above.
- **Modify** `src/tools/tools.ts` — merge read tools into `ReadPage`/`ReadTabs`/`QueryBrowserData`; add `ToolSearch`/`GetTool`; accept `activeNames`; derive catalog; `RequestPageControl` self-expands the control cluster.
- **Modify** `src/data/settings.ts` — `TOOL_CATALOG` rows; `DEFAULT_SYSTEM_PROMPT` rewrite.
- **Modify** `src/agent/agent.ts` — `runAgentTurn` accepts `activeNames`; `prepareStep` returns `activeTools`.
- **Modify** `src/ui/Chat.tsx` — create/seed `activeNames` per turn, pass it through; update `browsingInsightsNote`.
- **Modify** `README.md`, `CLAUDE.md` — tool list + disclosure model + invariant.

---

## Task 1: Pure tool-discovery module

**Files:**
- Create: `src/tools/toolDiscovery.ts`
- Test: `src/tools/toolDiscovery.test.ts`

**Interfaces:**
- Produces:
  - `interface CatalogEntry { name: string; description: string }`
  - `const ALWAYS_ON: readonly string[]` = `['ToolSearch', 'GetTool', 'ReadPage']`
  - `const META_NAMES: Set<string>` = `{'ToolSearch','GetTool'}`
  - `buildCatalog(tools: Record<string, { description?: string }>): CatalogEntry[]`
  - `searchCatalog(catalog: CatalogEntry[], query?: string): CatalogEntry[]`
  - `partitionToolNames(names: string[], catalog: CatalogEntry[]): { valid: string[]; unknown: string[] }`
  - `resolveActiveTools(activeNames: Set<string>, existing?: Iterable<string>): string[]`

- [ ] **Step 1: Write the failing test**

Create `src/tools/toolDiscovery.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  ALWAYS_ON,
  META_NAMES,
  buildCatalog,
  searchCatalog,
  partitionToolNames,
  resolveActiveTools,
  type CatalogEntry,
} from './toolDiscovery'

const TOOLS = {
  ToolSearch: { description: 'list tools' },
  GetTool: { description: 'load tools' },
  ReadPage: { description: 'Read the current tab' },
  ReadTabs: { description: 'List or read other open tabs' },
  QueryBrowserData: { description: 'history bookmarks top sites downloads' },
}

describe('buildCatalog', () => {
  it('lists real tools with descriptions and excludes meta-tools', () => {
    const cat = buildCatalog(TOOLS)
    const names = cat.map((e) => e.name)
    expect(names).toContain('ReadPage')
    expect(names).toContain('QueryBrowserData')
    expect(names).not.toContain('ToolSearch')
    expect(names).not.toContain('GetTool')
    expect(cat.find((e) => e.name === 'ReadPage')?.description).toBe('Read the current tab')
  })
  it('tolerates a missing description', () => {
    expect(buildCatalog({ Foo: {} })).toEqual([{ name: 'Foo', description: '' }])
  })
})

describe('searchCatalog', () => {
  const cat: CatalogEntry[] = buildCatalog(TOOLS)
  it('returns everything for an empty/omitted query', () => {
    expect(searchCatalog(cat)).toEqual(cat)
    expect(searchCatalog(cat, '   ')).toEqual(cat)
  })
  it('matches case-insensitively on name and description', () => {
    expect(searchCatalog(cat, 'READ').map((e) => e.name)).toEqual(['ReadPage', 'ReadTabs'])
    expect(searchCatalog(cat, 'bookmarks').map((e) => e.name)).toEqual(['QueryBrowserData'])
  })
  it('returns [] when nothing matches', () => {
    expect(searchCatalog(cat, 'zzz')).toEqual([])
  })
})

describe('partitionToolNames', () => {
  const cat = buildCatalog(TOOLS)
  it('splits known from unknown names', () => {
    expect(partitionToolNames(['ReadPage', 'Nope', 'ReadTabs'], cat)).toEqual({
      valid: ['ReadPage', 'ReadTabs'],
      unknown: ['Nope'],
    })
  })
})

describe('resolveActiveTools', () => {
  it('always includes the always-on core and dedupes', () => {
    const out = resolveActiveTools(new Set(['ReadPage', 'NavigateTab']))
    expect(out).toEqual(expect.arrayContaining([...ALWAYS_ON, 'NavigateTab']))
    expect(out.filter((n) => n === 'ReadPage')).toHaveLength(1)
  })
  it('intersects with existing tool names when provided', () => {
    const out = resolveActiveTools(new Set(['SearchMemory', 'Ghost']), ['ReadPage', 'ToolSearch', 'GetTool', 'SearchMemory'])
    expect(out).toContain('SearchMemory')
    expect(out).not.toContain('Ghost')
    expect(out).not.toContain('ReadTabs')
  })
})

describe('constants', () => {
  it('meta names are the two disclosure tools', () => {
    expect([...META_NAMES].sort()).toEqual(['GetTool', 'ToolSearch'])
    expect(ALWAYS_ON).toContain('ReadPage')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/tools/toolDiscovery.test.ts`
Expected: FAIL — `Cannot find module './toolDiscovery'` (file not created yet).

- [ ] **Step 3: Write the module**

Create `src/tools/toolDiscovery.ts`:

```ts
// Pure tool-discovery logic for progressive disclosure. No Chrome or AI-SDK
// imports — this is the unit-tested core that the meta-tools (ToolSearch,
// GetTool) and the turn loop (prepareStep -> activeTools) build on.

/** One row in the searchable tool catalog: a tool the model can load on demand. */
export interface CatalogEntry {
  name: string
  description: string
}

/**
 * Tools exposed to the model on every step without a discovery round-trip:
 * the two disclosure meta-tools plus ReadPage (the current-tab reader, by far
 * the most common action).
 */
export const ALWAYS_ON: readonly string[] = ['ToolSearch', 'GetTool', 'ReadPage']

/** The disclosure meta-tools themselves — excluded from the searchable catalog. */
export const META_NAMES: Set<string> = new Set(['ToolSearch', 'GetTool'])

/** Build the searchable catalog from an already-filtered ToolSet: name + description, minus meta-tools. */
export function buildCatalog(tools: Record<string, { description?: string }>): CatalogEntry[] {
  return Object.entries(tools)
    .filter(([name]) => !META_NAMES.has(name))
    .map(([name, t]) => ({ name, description: t.description ?? '' }))
}

/** Case-insensitive substring match over name + description. Empty/omitted query returns the whole catalog. */
export function searchCatalog(catalog: CatalogEntry[], query?: string): CatalogEntry[] {
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return catalog
  return catalog.filter((e) => `${e.name} ${e.description}`.toLowerCase().includes(q))
}

/** Split requested names into those present in the catalog and those that are not. */
export function partitionToolNames(
  names: string[],
  catalog: CatalogEntry[],
): { valid: string[]; unknown: string[] } {
  const known = new Set(catalog.map((e) => e.name))
  const valid: string[] = []
  const unknown: string[] = []
  for (const n of names) (known.has(n) ? valid : unknown).push(n)
  return { valid, unknown }
}

/**
 * The active tool set for a step: the always-on core plus everything loaded or
 * seeded so far. When `existing` (the turn's actual tool names) is given, the
 * result is intersected with it so a seeded/loaded name that was removed by
 * policy or permission never reaches `activeTools`.
 */
export function resolveActiveTools(activeNames: Set<string>, existing?: Iterable<string>): string[] {
  const all = new Set<string>([...ALWAYS_ON, ...activeNames])
  if (!existing) return Array.from(all)
  const exist = new Set(existing)
  return Array.from(all).filter((n) => exist.has(n))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/tools/toolDiscovery.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/toolDiscovery.ts src/tools/toolDiscovery.test.ts
git commit -m "feat: pure tool-discovery module (catalog, search, active-set)" -- src/tools/toolDiscovery.ts src/tools/toolDiscovery.test.ts
```

---

## Task 2: Consolidate current-tab readers into `ReadPage`

Merge `ViewCurrentTab` + `GetActiveTabDOM` + `InspectPage` into one mode-parameterized `ReadPage`. Preserve InspectPage's session/presence/vision path verbatim under `mode:'elements'`.

**Files:**
- Modify: `src/tools/tools.ts` (replace the three tool definitions; keep `MAX_DOM_CHARS`, `lookResult`, all imports)
- Modify: `src/data/settings.ts` (`TOOL_CATALOG` reading rows)

**Interfaces:**
- Consumes: existing `requestApproval`, `getActiveTab`, `readTabContent`, `readTabDom`, `snapshotPage`, `mountPresence`, `setTint`, `pageControl`, `lookResult`, `selected`, `imageQueue`, `DENIED`, `MAX_DOM_CHARS` (all already in `tools.ts`).
- Produces: tool `ReadPage` with input `{ mode: 'text'|'dom'|'elements', reason: string }`.

- [ ] **Step 1: Add `ReadPage`, remove the three merged tools**

In `src/tools/tools.ts`, delete the `ViewCurrentTab`, `InspectPage`, and `GetActiveTabDOM` tool definitions, and add this `ReadPage` in their place (put it first in the `tools` object):

```ts
    ReadPage: tool({
      description:
        'Read the tab the user is currently viewing. mode="text": title, URL, selected text and full visible text. mode="dom": the cleaned HTML structure (tags, attributes, links, form fields) when you need page structure rather than visible text. mode="elements": a numbered list of interactive elements (buttons, links, inputs) each with an [index] — use before controlling a page, or to re-read after it changes. Asks the user for permission first (except mode="elements" while a page-control session already owns this tab).',
      inputSchema: z.object({
        mode: z
          .enum(['text', 'dom', 'elements'])
          .describe('text = visible text; dom = HTML structure; elements = indexed interactive elements'),
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To summarize this article"'),
      }),
      execute: async ({ mode, reason }) => {
        const tab = await getActiveTab()
        if (tab?.id === undefined) return { error: 'No active tab found.' }
        if (mode === 'elements') {
          const open = pageControl.session()
          if (!open || !open.active || open.tabId !== tab.id) {
            const approved = await requestApproval({
              toolName: 'ReadPage',
              summary: 'Read the interactive elements on this page',
              reason,
            })
            if (!approved) return DENIED
          }
          // Ambient presence: idempotent, warms the overlay before a likely
          // RequestPageControl. lookResult hides it for the screenshot.
          await mountPresence(tab.id)
          // Mid-session re-read: keep the tinted "active control" look after a
          // navigation may have wiped the overlay.
          if (open && open.active && open.tabId === tab.id) await setTint(tab.id, true)
          try {
            const snap = await snapshotPage(tab.id)
            return await lookResult(tab, snap, {}, selected, imageQueue)
          } catch (err) {
            return { error: `Cannot read this page (${err instanceof Error ? err.message : String(err)}).` }
          }
        }
        const approved = await requestApproval({
          toolName: 'ReadPage',
          summary:
            mode === 'dom'
              ? 'Read the DOM/HTML structure of the tab you are on'
              : 'View the tab you are currently on',
          reason,
        })
        if (!approved) return DENIED
        if (mode === 'dom') return await readTabDom(tab.id, MAX_DOM_CHARS)
        return await readTabContent(tab.id)
      },
    }),
```

- [ ] **Step 2: Update `TOOL_CATALOG` reading rows**

In `src/data/settings.ts`, in `TOOL_CATALOG`, replace the three rows `ViewCurrentTab`, `ViewOpenedTabs`(leave), `InspectPage`, `GetActiveTabDOM` — specifically remove the `ViewCurrentTab`, `InspectPage`, and `GetActiveTabDOM` rows and add a `ReadPage` row as the first `reading` entry:

```ts
  { name: 'ReadPage', group: 'reading', label: 'Read the current tab (text / DOM / elements)' },
  { name: 'ViewOpenedTabs', group: 'reading', label: 'List / read other open tabs' },
  { name: 'GetAllDOM', group: 'reading', label: "Read other tabs' DOM" },
  { name: 'ExtractData', group: 'reading', label: 'Extract structured data from this page' },
  { name: 'StartResearch', group: 'reading', label: 'Run background web research' },
```

(`ViewOpenedTabs` and `GetAllDOM` are removed in Task 3.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `noUnusedLocals` flags an import that only `InspectPage` used, it will not — `mountPresence`/`setTint`/`snapshotPage`/`lookResult` are still used by `ReadPage` and other tools.)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 5: Manual verify** (`/verify-extension`)

Reload the unpacked extension. In the side panel:
- "summarize this page" → model calls `ReadPage` with `mode:"text"`; approval card reads "View the tab you are currently on"; a summary is produced.
- "what's the DOM structure of this page" → `ReadPage` `mode:"dom"`; card reads "Read the DOM/HTML structure…".
- On a vision-capable model, ask it to "find the buttons on this page" → `ReadPage` `mode:"elements"`; the set-of-marks screenshot appears and the presence overlay behaves (no stale tint left after the turn).

Note: `DEFAULT_SYSTEM_PROMPT` still names the old tools at this point; that is rewritten in Task 7. The model selects `ReadPage` from its description regardless.

- [ ] **Step 6: Commit**

```bash
git add src/tools/tools.ts src/data/settings.ts
git commit -m "feat: merge ViewCurrentTab/GetActiveTabDOM/InspectPage into ReadPage" -- src/tools/tools.ts src/data/settings.ts
```

---

## Task 3: Consolidate multi-tab readers into `ReadTabs`

Merge `ViewOpenedTabs` + `GetAllDOM` into `ReadTabs`.

**Files:**
- Modify: `src/tools/tools.ts` (replace two tool defs; update the active-tab deletion)
- Modify: `src/data/settings.ts` (`TOOL_CATALOG`)

**Interfaces:**
- Consumes: `listOpenTabs`, `readTabContent`, `readTabDom`, `MAX_DOM_CHARS_PER_TAB`, `requestApproval`, `DENIED`.
- Produces: tool `ReadTabs` with input `{ mode: 'text'|'dom', reason: string, tabIds?: number[] }`.

- [ ] **Step 1: Add `ReadTabs`, remove the two merged tools**

In `src/tools/tools.ts`, delete `ViewOpenedTabs` and `GetAllDOM`, and add:

```ts
    ReadTabs: tool({
      description:
        'List all tabs the user has open (titles, URLs, tab ids), and optionally read specific tabs by id. mode="text": visible text; mode="dom": cleaned HTML structure. Pass tabIds to read those tabs; omit tabIds to only list. Asks the user for permission first. Read only the tabs you need — each page is large.',
      inputSchema: z.object({
        mode: z.enum(['text', 'dom']).describe('text = visible text; dom = HTML structure'),
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To find your open documentation tabs"'),
        tabIds: z
          .array(z.number())
          .optional()
          .describe('Tab ids (from a previous listing) to read. Omit to only list tabs.'),
      }),
      execute: async ({ mode, reason, tabIds }) => {
        const reading = tabIds && tabIds.length > 0
        const approved = await requestApproval({
          toolName: 'ReadTabs',
          summary: reading
            ? `Read the ${mode === 'dom' ? 'DOM' : 'content'} of ${tabIds!.length} open tab${tabIds!.length > 1 ? 's' : ''}`
            : 'See the list of your open tabs',
          reason,
        })
        if (!approved) return DENIED
        const tabs = await listOpenTabs()
        if (!reading) return { tabs }
        if (mode === 'dom') {
          const doms = await Promise.all(tabIds!.map((id) => readTabDom(id, MAX_DOM_CHARS_PER_TAB)))
          return { tabs, doms }
        }
        const contents = await Promise.all(tabIds!.map((id) => readTabContent(id)))
        return { tabs, contents }
      },
    }),
```

- [ ] **Step 2: Update the active-tab visibility gate**

In `src/tools/tools.ts`, replace the two-line deletion block:

```ts
  // Honor the tab-visibility preference chosen in onboarding: in active-tab
  // mode the model never even sees a tool that could enumerate other tabs.
  if (tabAccess !== 'all-tabs') {
    delete tools.ReadTabs
  }
```

- [ ] **Step 3: Update `TOOL_CATALOG`**

In `src/data/settings.ts`, replace the `ViewOpenedTabs` and `GetAllDOM` reading rows (added-back in Task 2) with a single `ReadTabs` row:

```ts
  { name: 'ReadPage', group: 'reading', label: 'Read the current tab (text / DOM / elements)' },
  { name: 'ReadTabs', group: 'reading', label: 'List / read other open tabs (text / DOM)' },
  { name: 'ExtractData', group: 'reading', label: 'Extract structured data from this page' },
  { name: 'StartResearch', group: 'reading', label: 'Run background web research' },
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 5: Manual verify**

Reload. With tab access = all-tabs: "list my open tabs" → `ReadTabs` `mode:"text"`, no tabIds → returns the list; "read tabs 3 and 5" → returns their contents. Switch tab access = active-tab in Settings → `ReadTabs` is gone (model can only read the current tab). 

- [ ] **Step 6: Commit**

```bash
git add src/tools/tools.ts src/data/settings.ts
git commit -m "feat: merge ViewOpenedTabs/GetAllDOM into ReadTabs" -- src/tools/tools.ts src/data/settings.ts
```

---

## Task 4: Consolidate browsing-insight tools into `QueryBrowserData`

Merge `GetBrowsingHistory` + `GetBookmarks` + `GetTopSites` + `GetDownloads` into one `QueryBrowserData` with a `source` discriminator; keep per-source Chrome-permission gating.

**Files:**
- Modify: `src/tools/tools.ts` (replace four tool defs; rework the permission deletion; compute granted sources for the description)
- Modify: `src/data/settings.ts` (`TOOL_CATALOG` insights rows)
- Modify: `src/ui/Chat.tsx` (`browsingInsightsNote`)

**Interfaces:**
- Consumes: `getBrowsingHistory`, `getBookmarks`, `getTopSites`, `getDownloads`, `granted: Set<BrowsingCapability>`, `requestApproval`, `DENIED`.
- Produces: tool `QueryBrowserData` with input `{ source: 'history'|'bookmarks'|'topSites'|'downloads', reason: string, query?: string, sinceDays?: number, state?: 'complete'|'in_progress'|'interrupted', maxResults?: number }`.

- [ ] **Step 1: Compute granted sources near the top of `createAgentTools`**

In `src/tools/tools.ts`, just inside `createAgentTools` (before the `const tools: ToolSet = {` line), add:

```ts
  const BROWSING_SOURCES = ['history', 'bookmarks', 'topSites', 'downloads'] as const
  const grantedSources = BROWSING_SOURCES.filter((s) => granted.has(s))
  const sourcesLabel = grantedSources.length ? grantedSources.join(', ') : 'none currently enabled'
```

- [ ] **Step 2: Add `QueryBrowserData`, remove the four merged tools**

Delete `GetBrowsingHistory`, `GetBookmarks`, `GetTopSites`, `GetDownloads`, and add:

```ts
    QueryBrowserData: tool({
      description:
        `Draw on the user's own browser data. source="history": pages they visited; source="bookmarks": saved bookmarks; source="topSites": most-visited sites; source="downloads": downloaded files. Only enabled sources work (currently: ${sourcesLabel}). Asks the user for permission first. Use when the user refers to something they read, saved, or downloaded but did not share.`,
      inputSchema: z.object({
        source: z
          .enum(['history', 'bookmarks', 'topSites', 'downloads'])
          .describe('Which browser-data source to query'),
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To find the article you read about X"'),
        query: z
          .string()
          .optional()
          .describe('Terms to match (history / bookmarks / downloads). Omit to list recent.'),
        sinceDays: z.number().optional().describe('history only: how many days back (default 7).'),
        state: z
          .enum(['complete', 'in_progress', 'interrupted'])
          .optional()
          .describe('downloads only: filter by state.'),
        maxResults: z.number().optional().describe('Max entries to return.'),
      }),
      execute: async ({ source, reason, query, sinceDays, state, maxResults }) => {
        if (!granted.has(source)) {
          return { error: `The "${source}" source is not enabled. Ask the user to grant it in Settings → Permissions.` }
        }
        const summary =
          source === 'topSites'
            ? 'See your most-visited sites'
            : source === 'history'
              ? query
                ? `Search your browsing history for “${query}”`
                : 'Look through your recent browsing history'
              : source === 'bookmarks'
                ? query
                  ? `Search your bookmarks for “${query}”`
                  : 'List your recent bookmarks'
                : 'Look through your downloads'
        const approved = await requestApproval({ toolName: 'QueryBrowserData', summary, reason })
        if (!approved) return DENIED
        if (source === 'history') return { history: await getBrowsingHistory({ query, sinceDays, maxResults }) }
        if (source === 'bookmarks') return { bookmarks: await getBookmarks({ query, maxResults }) }
        if (source === 'topSites') return { sites: await getTopSites() }
        return { downloads: await getDownloads({ query, state, maxResults }) }
      },
    }),
```

- [ ] **Step 3: Replace the four permission deletions**

In `src/tools/tools.ts`, replace:

```ts
  if (!granted.has('history')) delete tools.GetBrowsingHistory
  if (!granted.has('bookmarks')) delete tools.GetBookmarks
  if (!granted.has('topSites')) delete tools.GetTopSites
  if (!granted.has('downloads')) delete tools.GetDownloads
```

with:

```ts
  // The single browsing-data tool is hidden entirely only when NO source is
  // granted; per-source gating happens inside its execute (and is named in its
  // description) so the model never requests an ungranted source.
  if (grantedSources.length === 0) delete tools.QueryBrowserData
```

- [ ] **Step 4: Update `TOOL_CATALOG` insights rows**

In `src/data/settings.ts`, replace the four `insights` rows (`GetBrowsingHistory`, `GetBookmarks`, `GetTopSites`, `GetDownloads`) with:

```ts
  { name: 'QueryBrowserData', group: 'insights', label: 'Browser data (history, bookmarks, top sites, downloads)' },
```

- [ ] **Step 5: Update `browsingInsightsNote` in `Chat.tsx`**

In `src/ui/Chat.tsx`, replace the whole `browsingInsightsNote` function with:

```ts
function browsingInsightsNote(granted: Set<BrowsingCapability>): string {
  const sources = (['history', 'bookmarks', 'topSites', 'downloads'] as const).filter((s) => granted.has(s))
  if (sources.length === 0) {
    return '\n\nThe QueryBrowserData tool (history, bookmarks, top sites, downloads) is currently turned off; do not offer to use it.'
  }
  return `\n\nQueryBrowserData sources available this turn: ${sources.join(', ')}.`
}
```

Then, if `npm run typecheck` reports `BROWSING_TOOL_NAMES` is now unused, delete its declaration from `Chat.tsx`.

- [ ] **Step 6: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both succeed (remove any now-unused import/const the compiler flags).

- [ ] **Step 7: Manual verify**

Reload. Grant only History in Settings → Permissions. Then:
- "find that article I read last week about X" → `QueryBrowserData` `source:"history"` → results.
- Ask it to check bookmarks → the model either avoids it (description says only history is enabled) or, if it tries, `QueryBrowserData` `source:"bookmarks"` returns the "not enabled" error (correctable, not a crash).
- Revoke all four → `QueryBrowserData` absent; `browsingInsightsNote` says it's off.

**Milestone A reached:** 14 real tools, all active, app fully works (no disclosure yet).

- [ ] **Step 8: Commit**

```bash
git add src/tools/tools.ts src/data/settings.ts src/ui/Chat.tsx
git commit -m "feat: merge browsing-insight tools into QueryBrowserData" -- src/tools/tools.ts src/data/settings.ts src/ui/Chat.tsx
```

---

## Task 5: Add `ToolSearch` + `GetTool` meta-tools and the `activeNames` plumbing

Add the two ungated meta-tools, derive the catalog after filtering, thread a mutable `activeNames` set into `createAgentTools`, and make `RequestPageControl` self-expand the control cluster. No gating happens yet (the turn loop is wired in Task 6, activated in Task 7), so all tools remain active and the app keeps working.

**Files:**
- Modify: `src/tools/tools.ts`

**Interfaces:**
- Consumes: `buildCatalog`, `searchCatalog`, `partitionToolNames`, `type CatalogEntry` from `./toolDiscovery`.
- Produces: `createAgentTools(..., conversationId: string, activeNames: Set<string>)`; tools `ToolSearch` `{ query?: string }` and `GetTool` `{ names: string[] }`.

- [ ] **Step 1: Import the pure helpers**

At the top of `src/tools/tools.ts`, add:

```ts
import { buildCatalog, searchCatalog, partitionToolNames, type CatalogEntry } from './toolDiscovery'
```

- [ ] **Step 2: Add the `activeNames` parameter**

Change the `createAgentTools` signature to append `activeNames`:

```ts
  /** The open conversation, tagged onto any background research launched this turn. */
  conversationId: string,
  /** Per-turn mutable set of loaded tool names; GetTool adds to it, the turn loop reads it. */
  activeNames: Set<string>,
): ToolSet {
```

- [ ] **Step 3: Declare the catalog closure and define the meta-tools**

Near the top of `createAgentTools` (just after `grantedSources`/`sourcesLabel` from Task 4), add:

```ts
  // Assigned after all filtering below, so the catalog and GetTool only ever
  // surface tools that survive tabAccess / permission / policy gating.
  let catalog: CatalogEntry[] = []
```

Add these two tools inside the `tools` object (e.g. right after `ReadPage`):

```ts
    ToolSearch: tool({
      description:
        "List the tools available to you (name + description), optionally filtered by a query. Tools are not loaded until you select them. After finding what you need, call GetTool with their names to load them. Use this when the user's request needs a capability beyond reading the current page.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Optional keywords to filter the list (matches name + description). Omit to list all.'),
      }),
      execute: async ({ query }) => ({ tools: searchCatalog(catalog, query) }),
    }),

    GetTool: tool({
      description:
        'Load one or more tools by name so you can call them for the rest of this turn. Get names from ToolSearch. Loading a tool does not run it — you still call it afterward, and it still asks the user for permission when it runs.',
      inputSchema: z.object({
        names: z.array(z.string()).min(1).describe('Exact tool names to load, from ToolSearch.'),
      }),
      execute: async ({ names }) => {
        const { valid, unknown } = partitionToolNames(names, catalog)
        valid.forEach((n) => activeNames.add(n))
        if (unknown.length > 0) {
          return { loaded: valid, error: `Unknown tool name(s): ${unknown.join(', ')}. Call ToolSearch to see valid names.` }
        }
        return { loaded: valid, note: 'These tools are now available to call.' }
      },
    }),
```

- [ ] **Step 4: `RequestPageControl` self-expands the control cluster**

In `RequestPageControl`'s `execute`, right after the session is granted (`if (!granted) return DENIED`), add:

```ts
        // Loading the control cluster so the model can act without a second
        // GetTool round-trip once a session is open.
        activeNames.add('ControlPage')
        activeNames.add('AutofillForm')
```

(The local `const granted = await pageControl.requestSession(...)` already shadows the `granted` capability set; leave that as-is.)

- [ ] **Step 5: Derive the catalog after all filtering**

At the end of `createAgentTools`, just before `return tools`, add:

```ts
  // Catalog is derived AFTER every deletion above, so ToolSearch/GetTool can
  // never surface or load a tool the user disabled or lacks permission for.
  catalog = buildCatalog(tools)

  return tools
```

Confirm the `never`-policy loop does not remove the meta-tools: they are absent from `TOOL_CATALOG`, so `toolPolicy` returns `'ask'` and they survive. (No change needed; just verify.)

- [ ] **Step 6: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: FAILS typecheck at the `createAgentTools(...)` call in `Chat.tsx` (missing `activeNames` arg). That is expected and fixed in Task 7. To keep this task independently green, temporarily pass an empty set at the call site now:

In `src/ui/Chat.tsx`, in the `createAgentTools(...)` call, add a final argument after `conversationId,`:

```ts
          conversationId,
          new Set<string>(),
```

Re-run: `npm run typecheck && npm run build` → both succeed.

- [ ] **Step 7: Manual verify**

Reload. Ask "what tools do you have?" → the model calls `ToolSearch` and lists the 14 real tools (no `ToolSearch`/`GetTool` in the list). Ask it to load one: it calls `GetTool(["NavigateTab"])` → `{ loaded: ["NavigateTab"], note: ... }`. All tools still work as before (no gating yet — the empty set passed in Step 6 means nothing is restricted).

- [ ] **Step 8: Commit**

```bash
git add src/tools/tools.ts src/ui/Chat.tsx
git commit -m "feat: add ToolSearch/GetTool meta-tools + activeNames plumbing" -- src/tools/tools.ts src/ui/Chat.tsx
```

---

## Task 6: Return `activeTools` from the turn loop

Wire `activeNames` through `runAgentTurn` and have `prepareStep` return `activeTools`. Made optional so this task alone changes no behavior (Chat.tsx still passes a fresh empty set from Task 5; real seeding lands in Task 7).

**Files:**
- Modify: `src/agent/agent.ts`

**Interfaces:**
- Consumes: `resolveActiveTools` from `../tools/toolDiscovery`.
- Produces: `runAgentTurn(options: { ...; activeNames?: Set<string> })`.

- [ ] **Step 1: Import the resolver**

At the top of `src/agent/agent.ts`, add:

```ts
import { resolveActiveTools } from '../tools/toolDiscovery'
```

- [ ] **Step 2: Add the option**

In the `runAgentTurn` options type, after `imageQueue?: string[]`, add:

```ts
  /**
   * Per-turn set of tool names the model has loaded (via GetTool) or the app
   * has seeded from context. When present, each step's `activeTools` is the
   * always-on core plus this set, intersected with the turn's real tools — so
   * only those tool schemas are sent to the model. Absent = every tool active
   * (legacy behavior).
   */
  activeNames?: Set<string>
```

- [ ] **Step 3: Return `activeTools` from `prepareStep`**

Replace the current `prepareStep` body so both branches carry `activeTools`:

```ts
    prepareStep: ({ initialMessages, responseMessages }) => {
      // v7: a returned `messages` override carries forward to later steps, so
      // rebuild the base each step from initialMessages + responseMessages (this
      // keeps a set-of-marks screenshot visible only to the step that acts on
      // the element list it matches).
      const base = [...initialMessages, ...responseMessages]
      const activeTools = options.activeNames
        ? resolveActiveTools(options.activeNames, Object.keys(tools))
        : undefined
      const queue = options.imageQueue
      if (!queue || queue.length === 0) {
        return activeTools ? { messages: base, activeTools } : { messages: base }
      }
      const imgs = queue.splice(0, queue.length)
      const injected: ModelMessage[] = imgs.map((dataUrl) => ({
        role: 'user',
        content: [
          { type: 'file' as const, mediaType: 'image', data: dataUrl },
          {
            type: 'text' as const,
            text: 'Set-of-marks screenshot of the current page — the numbered boxes correspond to the [index] values in the element list you just read.',
          },
        ],
      }))
      const messages = [...base, ...injected]
      return activeTools ? { messages, activeTools } : { messages }
    },
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both succeed. (Chat.tsx does not yet pass `activeNames` to `runAgentTurn`, so `activeTools` stays `undefined` → behavior unchanged.)

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent.ts
git commit -m "feat: prepareStep returns activeTools from a per-turn active set" -- src/agent/agent.ts
```

---

## Task 7: Activate disclosure — seed/pass `activeNames` and rewrite the system prompt

This is the activation task: create and seed `activeNames` in `Chat.tsx`, pass it to both `createAgentTools` and `runAgentTurn`, and rewrite `DEFAULT_SYSTEM_PROMPT` to the disclosure protocol. Gating and the prompt land together so the app stays working.

**Files:**
- Modify: `src/ui/Chat.tsx`
- Modify: `src/data/settings.ts`

**Interfaces:**
- Consumes: `createAgentTools(..., conversationId, activeNames)` (Task 5), `runAgentTurn({ ..., activeNames })` (Task 6), `pageControl.session()`.

- [ ] **Step 1: Create and seed `activeNames`**

In `src/ui/Chat.tsx`, immediately before `const imageQueue: string[] = []`, add:

```ts
      // Per-turn set of tools exposed to the model beyond the always-on core.
      // Seeded from context so common flows skip a discovery round-trip:
      // @memory pre-loads SearchMemory; an already-open page-control session
      // pre-loads the control cluster. GetTool grows it during the turn.
      const activeNames = new Set<string>()
      if (useMemory) activeNames.add('SearchMemory')
      const openSession = pageControl.session()
      if (openSession && openSession.active) {
        activeNames.add('RequestPageControl')
        activeNames.add('ControlPage')
        activeNames.add('AutofillForm')
      }
```

- [ ] **Step 2: Pass `activeNames` to both calls**

Replace the temporary `new Set<string>()` argument added in Task 5 with `activeNames`:

```ts
          conversationId,
          activeNames,
        ),
```

And add `activeNames` to the `runAgentTurn` options (next to `imageQueue`):

```ts
        onUpdate: updateAssistant,
        imageQueue,
        activeNames,
      })
```

- [ ] **Step 3: Rewrite `DEFAULT_SYSTEM_PROMPT`**

In `src/data/settings.ts`, replace the entire `DEFAULT_SYSTEM_PROMPT` string with:

```ts
export const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI agent living in the user's browser side panel.

You cannot see any webpage or use any capability by default. Your tools load on demand:
- ReadPage is always available — read the tab the user is currently viewing. mode "text" for visible text, "dom" for HTML structure, "elements" for a numbered list of interactive elements (use before controlling a page).
- For anything else, call ToolSearch to list the available tools (optionally with a query), then GetTool with the names you need to load them. Loaded tools stay available for the rest of this turn. Loading a tool does not run it, and tools still ask the user for permission when they run.

Available capabilities to load via ToolSearch/GetTool when a request needs them:
- ReadTabs — list or read other open tabs (text or DOM).
- RequestPageControl, ControlPage, AutofillForm — control a page: click, type, fill a form, click through a flow.
- NavigateTab — switch to, open, or load a URL in a tab.
- ExtractData — pull structured JSON out of the current page.
- SaveMemory, SearchMemory — long-term memory about the user, stored locally.
- QueryBrowserData — the user's history, bookmarks, top sites, or downloads (only enabled sources work).
- ListAllSkills, ReadSkill, SaveSkill — saved instruction sets for specific tasks.
- StartResearch — launch a background web-research task.

If the message needs no tools, just answer.

The user can @mention tabs; when they do, the tab's content arrives inside <tab> blocks appended to their message — treat it as up-to-date page content they shared (no tool call needed). They may type @memory to ask you to consult your long-term memory (SearchMemory) before answering.

Your long-term memory is stored locally in the browser. The most relevant memories appear in a "Long-term memory" section of this prompt when any exist; while you sleep, a "dreaming" process distills each day's conversations into new memories.

When you use a tool the user is asked to approve it first; they may deny it. Never fabricate page content — if you were denied access, say so and answer from general knowledge.

Be concise and direct.`
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 5: Full manual verify** (`/verify-extension`) — **Milestone B**

Reload the unpacked extension. During dev, temporarily add `console.log('activeTools', activeTools)` in `prepareStep` (remove before commit) to confirm the active set per step. Exercise:

1. **No-tool turn** — "explain closures" → the model answers with no tool call; the only active tools are `ToolSearch`, `GetTool`, `ReadPage`.
2. **1-step read** — "summarize this page" → `ReadPage` `mode:"text"` directly, no `ToolSearch`/`GetTool` round-trip.
3. **Discovery → control** — "fill this signup form" → `ToolSearch` → `GetTool(["RequestPageControl", ...])` (or straight `GetTool` using the prompt's capability list) → `RequestPageControl` (session card) → `ControlPage` steps; point-of-no-return cards still fire on submit / cross-origin / password fields.
4. **Insights** — with only History granted: "find that article I read" → `GetTool(["QueryBrowserData"])` → `QueryBrowserData` `source:"history"`. A `source:"bookmarks"` attempt returns the correctable "not enabled" error.
5. **active-tab mode** — `ToolSearch` does not list `ReadTabs`; `GetTool(["ReadTabs"])` returns "Unknown tool name".
6. **@memory** — "@memory what did we say about my thesis?" → `SearchMemory` is callable with no discovery step and no approval card (pre-seeded + `turnAllowed`).
7. **Continuing a control session across turns** — after a session is open, a new turn already has `ControlPage`/`AutofillForm` active (no discovery round-trip).

Remove the temporary `console.log` before committing.

- [ ] **Step 6: Commit**

```bash
git add src/ui/Chat.tsx src/data/settings.ts
git commit -m "feat: activate progressive tool disclosure (seed/pass activeNames + prompt)" -- src/ui/Chat.tsx src/data/settings.ts
```

---

## Task 8: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `CLAUDE.md`**

- In the `src/tools/` bullet, note `toolDiscovery.ts` (pure catalog/search/active-set logic) and that `tools.ts` exposes tools via progressive disclosure.
- Under "Architecture invariants", replace the stale "There is no test suite" guidance in the verifying-a-change section if present, and add an invariant:

```md
- **Tools are progressively disclosed.** Only an always-on core (`ToolSearch`, `GetTool`, `ReadPage`) is active by default; the model lists the rest via `ToolSearch` and loads them with `GetTool`, which adds to the per-turn `activeNames` set that `runAgentTurn`'s `prepareStep` turns into the step's `activeTools`. New tools still go in `createAgentTools`, still route through `requestApproval`, and become discoverable automatically (the catalog is derived from the filtered ToolSet).
```

- Fix the "Verifying a change" section: a Vitest suite now exists (`npm test`); keep the `/verify-extension` guidance for runtime flows.

- [ ] **Step 2: Update `README.md`**

In the tool/architecture map, replace the individual read/insight tool names with `ReadPage`, `ReadTabs`, `QueryBrowserData`, and mention the `ToolSearch`/`GetTool` on-demand model. Keep the rest of the tool list current (14 real tools + 2 meta).

- [ ] **Step 3: Verify docs reference real symbols**

Run: `grep -nE "ViewCurrentTab|GetActiveTabDOM|InspectPage|ViewOpenedTabs|GetAllDOM|GetBrowsingHistory|GetBookmarks|GetTopSites|GetDownloads" README.md CLAUDE.md`
Expected: no matches (all replaced by the merged names).

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: progressive tool disclosure + consolidated tool names" -- README.md CLAUDE.md
```

---

## Self-Review (completed during authoring)

**Spec coverage:** progressive disclosure mechanism (Tasks 5–7) ✓; `ToolSearch`/`GetTool` (Task 5) ✓; always-on core `ToolSearch`/`GetTool`/`ReadPage` (Tasks 5–7) ✓; consolidation `ReadPage`/`ReadTabs`/`QueryBrowserData` (Tasks 2–4) ✓; per-source insight gating (Task 4) ✓; turn-conditional seeding — @memory, open session, RequestPageControl self-expand (Tasks 5, 7) ✓; catalog derived after filtering (Task 5) ✓; `TOOL_CATALOG` + permission-matrix migration (Tasks 2–4) ✓; system-prompt rewrite (Task 7) ✓; `agent.ts` `activeTools` via `prepareStep` (Task 6) ✓; docs + invariant (Task 8) ✓. Native v7 `toolApproval`/`ToolLoopAgent` intentionally out of scope (per spec).

**Type consistency:** `activeNames: Set<string>` is the same name/type across `createAgentTools` (Task 5), `runAgentTurn` option (Task 6), and `Chat.tsx` (Task 7). `resolveActiveTools`, `buildCatalog`, `searchCatalog`, `partitionToolNames`, `CatalogEntry`, `ALWAYS_ON`, `META_NAMES` names match Task 1's definitions everywhere used.

**Migration note:** `settings.toolPolicies` is a sparse map keyed by name; old keys (`ViewCurrentTab`, …) go inert and merged tools default to `ask`. A user who set a removed tool to `never` re-sets it on the merged tool. Acceptable for this project.
