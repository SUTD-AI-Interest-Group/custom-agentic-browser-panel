# Browsing-data agent tools — design

**Date:** 2026-07-10
**Status:** Approved, ready for implementation plan

## Summary

Add four read-only agent tools that let the AI autonomously enrich requests
with the user's own browser data:

- `GetBrowsingHistory` — `chrome.history.search`
- `GetBookmarks` — `chrome.bookmarks.search` / `getRecent`
- `GetTopSites` — `chrome.topSites.get`
- `GetDownloads` — `chrome.downloads.search`

The model decides *when* to call them (autonomy); the user still approves each
call via the existing human-in-the-loop card, and each underlying Chrome
permission is optional and granted only after the user opts in from Settings.

## Motivation

The panel can already read tabs and long-term memory. It cannot answer
"what was that article I read last week?", "did I bookmark the docs?",
"which sites do I use most?", or "where's the file I downloaded?" — because it
has no window into history, bookmarks, top sites, or downloads. These four
tools close that gap while preserving the extension's privacy-forward posture.

## Privacy posture (decided)

History, bookmarks, and downloads are more sensitive than open tabs, and each
permission adds an install-time warning. Decisions:

1. **Optional permissions, granted on opt-in.** The four permissions live in
   `optional_permissions`, so the install prompt stays clean. They are granted
   at runtime from a Settings toggle (a user gesture, required by
   `chrome.permissions.request`).
2. **Granted permission is the source of truth.** No new field is added to
   `Settings`. `chrome.permissions.contains` is queried to know what is on.
3. **Tools are hidden until granted.** The model never sees a capability that
   is off — mirroring how `ViewOpenedTabs` is deleted in active-tab mode.
4. **Per-call approval still applies.** Every tool routes through
   `requestApproval` before it runs, per the architecture invariant.
5. **Master + per-capability toggles.** Settings shows a master "Browsing
   insights" switch that flips all four together, plus one switch per
   capability for granular control.

## Components

### 1. `src/platform/permissions.ts` (new)

Small helper around the optional permissions. Capability keys are the four
Chrome permission names themselves to avoid a second vocabulary.

```ts
export type BrowsingCapability = 'history' | 'bookmarks' | 'topSites' | 'downloads'

export const BROWSING_CAPABILITIES: BrowsingCapability[]

/** Which browsing capabilities are currently granted. */
export async function grantedCapabilities(): Promise<Set<BrowsingCapability>>

/** Request one capability. Must be called from a user gesture. Returns granted. */
export async function requestCapability(cap: BrowsingCapability): Promise<boolean>

/** Remove one capability. Returns whether it is now absent. */
export async function removeCapability(cap: BrowsingCapability): Promise<boolean>
```

`requestCapability`/`removeCapability` wrap `chrome.permissions.request` /
`chrome.permissions.remove` with `{ permissions: [cap] }`. The master toggle in
the UI calls these for each capability (request accepts an array for a single
combined Chrome prompt when turning all on).

### 2. `src/platform/browsingData.ts` (new)

Follows the `src/platform/tabs.ts` pattern: thin wrappers that call the Chrome
APIs and map results to compact, token-friendly shapes. Timestamps normalized
to ISO strings; lists capped.

```ts
export interface HistoryEntry { title: string; url: string; lastVisit: string; visitCount: number }
export interface BookmarkEntry { title: string; url: string; folder: string; dateAdded: string }
export interface TopSiteEntry { title: string; url: string }
export interface DownloadEntry { filename: string; url: string; state: string; sizeBytes: number; startTime: string; mime: string }

export async function getBrowsingHistory(opts: { query?: string; sinceDays?: number; maxResults?: number }): Promise<HistoryEntry[]>
export async function getBookmarks(opts: { query?: string; maxResults?: number }): Promise<BookmarkEntry[]>
export async function getTopSites(): Promise<TopSiteEntry[]>
export async function getDownloads(opts: { query?: string; state?: string; maxResults?: number }): Promise<DownloadEntry[]>
```

Details:

- **History:** `chrome.history.search({ text: query ?? '', startTime: now - sinceDays*86400_000, maxResults })`. `sinceDays` default 7; `maxResults` default 50, hard cap 200. Map `lastVisitTime`→ISO; drop entries without a URL.
- **Bookmarks:** if `query` present → `chrome.bookmarks.search(query)`; else `getRecent(maxResults)`. Keep only nodes with a `url` (skip folders). `folder` = title of the parent node when resolvable, else `''`. `dateAdded`→ISO. Default/cap `maxResults` 50.
- **Top sites:** `chrome.topSites.get()`; return `{title, url}` as-is (Chrome already limits the count).
- **Downloads:** `chrome.downloads.search({ query: query ? [query] : [], state, orderBy: ['-startTime'], limit: maxResults })`. `maxResults` default 25. `filename` reduced to its basename (strip the local directory path). Map size from `bytesReceived`/`totalBytes`.

### 3. `src/tools/tools.ts` (edit)

Add the four `tool()` definitions inside `createAgentTools`, each following the
existing shape: a `reason` string in the input schema, a `requestApproval` call
with a human-readable `summary`, `return DENIED` on refusal, then the platform
helper call.

Approval summaries:

- `GetBrowsingHistory` → `Search your browsing history for "<query>"` (or `Look through your recent browsing history` when no query).
- `GetBookmarks` → `Search your bookmarks for "<query>"` (or `List your recent bookmarks`).
- `GetTopSites` → `See your most-visited sites`.
- `GetDownloads` → `Look through your downloads`.

Gating: `createAgentTools` gains a third parameter
`granted: Set<BrowsingCapability>`. After building the toolset, delete each
browsing-data tool whose capability is not in `granted` — same shape as the
existing `if (tabAccess !== 'all-tabs') delete tools.ViewOpenedTabs` line.

Signature becomes:

```ts
export function createAgentTools(
  requestApproval: ApprovalGate,
  tabAccess: TabAccess,
  granted: Set<BrowsingCapability>,
): ToolSet
```

### 4. `src/ui/Chat.tsx` (edit)

- At turn start (already an async block), call `grantedCapabilities()` and pass
  the result into `createAgentTools(requestApproval, settings.tabAccess, granted)`.
- Build a dynamic note (like the existing `accessNote`) that appends to the
  system prompt: list which browsing-insight tools are available this turn so
  the model does not attempt a disabled one. When none are granted, the note
  says the browsing-insight tools are off.

### 5. `src/data/settings.ts` (edit)

Extend `DEFAULT_SYSTEM_PROMPT` with a short paragraph describing the four tools
and when to use them autonomously — e.g. when the user references something they
read, downloaded, or bookmarked earlier but did not share, or asks about their
own browsing patterns. Note they require permission and may be unavailable.

### 6. `src/ui/Settings.tsx` + `src/ui/styles.css` (edit)

New **"Browsing insights"** section:

- **Master switch** — reflects "all four granted". On → request all four
  (`chrome.permissions.request({ permissions: [...all] })`, one combined
  prompt). Off → remove all four.
- **Four child switches** — History, Bookmarks, Top Sites, Downloads. Each
  request/remove its own capability.
- Initial state read on mount via `grantedCapabilities()`.
- Subscribe to `chrome.permissions.onAdded` / `onRemoved` to stay in sync when
  the user grants/revokes elsewhere (e.g. `chrome://extensions`); unsubscribe on
  unmount.
- Requests fire from the switch `onChange`/click handler (the user gesture).

### 7. `public/manifest.json` (edit)

Add:

```json
"optional_permissions": ["history", "bookmarks", "topSites", "downloads"]
```

## Data flow

1. User enables a capability (or the master) in Settings → `chrome.permissions.request` grants it.
2. Next turn, `Chat.tsx` reads `grantedCapabilities()` and builds the toolset + prompt note.
3. Model, seeing the available tool, calls it with a `reason` to enrich its answer.
4. `requestApproval` shows the inline card; on Allow, the platform helper runs and returns compact data; on Deny, `DENIED` is returned.
5. If the user later revokes a permission, the tool disappears from the next turn's toolset.

## Error handling

- Helpers wrap Chrome calls defensively and return `{ error }` (or an empty list
  with a note) rather than throwing, so a rejected/edge-case API call surfaces
  as a normal tool result the model can explain.
- Tool gating means a disabled capability cannot be called; no runtime
  permission error path is expected, but each `execute()` still tolerates an
  empty/absent result.

## Testing / verification

No test suite exists. Verify via the `/verify-extension` flow:

1. `npm run build` (typecheck + build).
2. Reload the unpacked extension in `chrome://extensions`.
3. In Settings, toggle the master switch → confirm one combined Chrome prompt,
   all four tools become usable. Toggle a single child on/off → confirm its
   Chrome prompt and that only that tool appears/disappears.
4. Ask the agent something that should trigger each tool (e.g. "what was that
   article I read about X last week?") → confirm the approval card, the returned
   data, and a sensible answer.
5. Revoke a permission from `chrome://extensions` → confirm the Settings switch
   updates and the tool is gone next turn.

## Scope boundaries (YAGNI)

- Read-only. No history/bookmark deletion, no `chrome.browsingData` clearing.
- No reading-list, tabGroups, or windows tools in this iteration.
- Onboarding is unchanged; browsing insights are enabled later from Settings.
