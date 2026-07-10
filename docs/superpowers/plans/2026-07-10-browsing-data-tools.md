# Browsing-data agent tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four read-only agent tools (`GetBrowsingHistory`, `GetBookmarks`, `GetTopSites`, `GetDownloads`) the model can call autonomously to enrich answers with the user's own browser data, gated by optional permissions and the existing approval card.

**Architecture:** New platform helpers wrap the Chrome `history`/`bookmarks`/`topSites`/`downloads` APIs (`browsingData.ts`) and the optional-permission grant/remove/query flow (`permissions.ts`). The four tools join `createAgentTools`, routing through the existing `requestApproval` gate, and are deleted from the toolset when their permission is not granted — mirroring how `ViewOpenedTabs` is hidden in active-tab mode. A self-contained "Browsing insights" Settings section grants/revokes the permissions live.

**Tech Stack:** Chrome Extension MV3, React 18, TypeScript (strict), Vercel AI SDK v5 (`tool()` + `zod`), Vite 6.

## Global Constraints

- **No test suite exists.** The automated gate is `npm run typecheck` (alias for `tsc --noEmit`); `npm run build` runs `tsc --noEmit && vite build`. Acceptance is manual browser verification via the `/verify-extension` flow. There is no unit-test runner — do **not** invent one.
- **Code style (convention-only, match by hand):** no semicolons (ASI), single quotes, 2-space indent. Prefer `interface` for object shapes, `type` for unions. Document exported types/functions with `/** ... */`.
- **Architecture invariant:** every agent tool's `execute()` must call `requestApproval(...)` and `return DENIED` on refusal before doing any work.
- **Privacy invariant:** the model must never see a browsing-data tool whose Chrome permission is not currently granted.
- **Git:** commit directly to `main`. Do **not** add any `Co-Authored-By` or "Generated with" trailer to commit messages.

---

### Task 1: Optional permissions + `permissions.ts` helper

**Files:**
- Modify: `public/manifest.json:7-8`
- Create: `src/platform/permissions.ts`

**Interfaces:**
- Produces:
  - `type BrowsingCapability = 'history' | 'bookmarks' | 'topSites' | 'downloads'`
  - `const BROWSING_CAPABILITIES: BrowsingCapability[]`
  - `async function grantedCapabilities(): Promise<Set<BrowsingCapability>>`
  - `async function requestCapabilities(caps: BrowsingCapability[]): Promise<boolean>`
  - `async function removeCapabilities(caps: BrowsingCapability[]): Promise<boolean>`

- [ ] **Step 1: Add `optional_permissions` to the manifest**

In `public/manifest.json`, immediately after the `"permissions"` array (line 7) and before `"host_permissions"` (line 8), add:

```json
  "optional_permissions": ["history", "bookmarks", "topSites", "downloads"],
```

The result reads:

```json
  "permissions": ["sidePanel", "storage", "scripting", "tabs", "alarms", "activeTab", "clipboardWrite"],
  "optional_permissions": ["history", "bookmarks", "topSites", "downloads"],
  "host_permissions": ["<all_urls>"],
```

- [ ] **Step 2: Create `src/platform/permissions.ts`**

```ts
// Optional-permission helpers for the browsing-data tools.
//
// history, bookmarks, topSites and downloads live in the manifest's
// optional_permissions, so the install prompt stays clean. They are granted at
// runtime from the Settings toggles (chrome.permissions.request must run inside
// a user gesture — the toggle click). The granted permission is the single
// source of truth for whether a capability is on; nothing is mirrored into
// Settings.

/** A browser-data capability, keyed by its Chrome permission name. */
export type BrowsingCapability = 'history' | 'bookmarks' | 'topSites' | 'downloads'

/** All browsing capabilities, in the order shown in Settings. */
export const BROWSING_CAPABILITIES: BrowsingCapability[] = [
  'history',
  'bookmarks',
  'topSites',
  'downloads',
]

/** The browsing capabilities the user has currently granted. */
export async function grantedCapabilities(): Promise<Set<BrowsingCapability>> {
  const granted = new Set<BrowsingCapability>()
  await Promise.all(
    BROWSING_CAPABILITIES.map(async (cap) => {
      if (await chrome.permissions.contains({ permissions: [cap] })) granted.add(cap)
    }),
  )
  return granted
}

/**
 * Request one or more capabilities. Must be called synchronously from a user
 * gesture (e.g. a Settings toggle click). Resolves to whether the request was
 * granted.
 */
export async function requestCapabilities(caps: BrowsingCapability[]): Promise<boolean> {
  if (caps.length === 0) return true
  return chrome.permissions.request({ permissions: caps })
}

/** Remove one or more capabilities. Resolves to whether removal succeeded. */
export async function removeCapabilities(caps: BrowsingCapability[]): Promise<boolean> {
  if (caps.length === 0) return true
  return chrome.permissions.remove({ permissions: caps })
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add public/manifest.json src/platform/permissions.ts
git commit -m "feat: optional browsing permissions + permissions helper"
```

---

### Task 2: `browsingData.ts` platform helper

**Files:**
- Create: `src/platform/browsingData.ts`

**Interfaces:**
- Consumes: nothing (calls Chrome APIs directly).
- Produces:
  - `interface HistoryEntry { title: string; url: string; lastVisit: string; visitCount: number }`
  - `interface BookmarkEntry { title: string; url: string; folder: string; dateAdded: string }`
  - `interface TopSiteEntry { title: string; url: string }`
  - `interface DownloadEntry { filename: string; url: string; state: string; sizeBytes: number; startTime: string; mime: string }`
  - `async function getBrowsingHistory(opts?: { query?: string; sinceDays?: number; maxResults?: number }): Promise<HistoryEntry[]>`
  - `async function getBookmarks(opts?: { query?: string; maxResults?: number }): Promise<BookmarkEntry[]>`
  - `async function getTopSites(): Promise<TopSiteEntry[]>`
  - `async function getDownloads(opts?: { query?: string; state?: 'complete' | 'in_progress' | 'interrupted'; maxResults?: number }): Promise<DownloadEntry[]>`

- [ ] **Step 1: Create `src/platform/browsingData.ts`**

```ts
// Read-only wrappers over Chrome's history, bookmarks, topSites and downloads
// APIs, each mapped to a compact, token-friendly shape for the agent tools.
// Follows the src/platform/tabs.ts pattern: thin, defensive, no UI. Callers are
// responsible for having the matching optional permission granted (see
// permissions.ts); these run only after the tool is exposed to the model.

export interface HistoryEntry {
  title: string
  url: string
  /** ISO 8601 timestamp of the most recent visit. */
  lastVisit: string
  visitCount: number
}

export interface BookmarkEntry {
  title: string
  url: string
  /** Best-effort parent folder name; '' when unknown. */
  folder: string
  /** ISO 8601 timestamp the bookmark was added. */
  dateAdded: string
}

export interface TopSiteEntry {
  title: string
  url: string
}

export interface DownloadEntry {
  /** Basename of the downloaded file (local directory path stripped). */
  filename: string
  url: string
  /** 'complete' | 'in_progress' | 'interrupted'. */
  state: string
  sizeBytes: number
  /** ISO 8601 timestamp the download started. */
  startTime: string
  mime: string
}

const DAY_MS = 86_400_000

const isoOrEmpty = (ms?: number): string => (ms ? new Date(ms).toISOString() : '')

export async function getBrowsingHistory(
  opts: { query?: string; sinceDays?: number; maxResults?: number } = {},
): Promise<HistoryEntry[]> {
  const sinceDays = opts.sinceDays ?? 7
  const maxResults = Math.min(opts.maxResults ?? 50, 200)
  const items = await chrome.history.search({
    text: opts.query ?? '',
    startTime: Date.now() - sinceDays * DAY_MS,
    maxResults,
  })
  return items
    .filter((i) => i.url)
    .map((i) => ({
      title: i.title || '(untitled)',
      url: i.url!,
      lastVisit: isoOrEmpty(i.lastVisitTime),
      visitCount: i.visitCount ?? 0,
    }))
}

export async function getBookmarks(
  opts: { query?: string; maxResults?: number } = {},
): Promise<BookmarkEntry[]> {
  const maxResults = Math.min(opts.maxResults ?? 50, 200)
  const nodes = opts.query
    ? await chrome.bookmarks.search(opts.query)
    : await chrome.bookmarks.getRecent(maxResults)
  const bookmarks = nodes.filter((n) => n.url).slice(0, maxResults)

  // Resolve parent-folder titles best-effort, caching lookups per folder id.
  const folderCache = new Map<string, string>()
  const folderTitle = async (parentId?: string): Promise<string> => {
    if (!parentId) return ''
    const cached = folderCache.get(parentId)
    if (cached !== undefined) return cached
    let title = ''
    try {
      const [parent] = await chrome.bookmarks.get(parentId)
      title = parent?.title ?? ''
    } catch {
      title = ''
    }
    folderCache.set(parentId, title)
    return title
  }

  return Promise.all(
    bookmarks.map(async (n) => ({
      title: n.title || '(untitled)',
      url: n.url!,
      folder: await folderTitle(n.parentId),
      dateAdded: isoOrEmpty(n.dateAdded),
    })),
  )
}

export async function getTopSites(): Promise<TopSiteEntry[]> {
  const sites = await chrome.topSites.get()
  return sites.map((s) => ({ title: s.title || s.url, url: s.url }))
}

export async function getDownloads(
  opts: { query?: string; state?: 'complete' | 'in_progress' | 'interrupted'; maxResults?: number } = {},
): Promise<DownloadEntry[]> {
  const limit = Math.min(opts.maxResults ?? 25, 100)
  const items = await chrome.downloads.search({
    query: opts.query ? [opts.query] : [],
    state: opts.state,
    orderBy: ['-startTime'],
    limit,
  })
  return items.map((d) => ({
    // chrome.downloads.filename is an absolute local path; keep only the name.
    filename: d.filename ? d.filename.replace(/^.*[\\/]/, '') : '(unknown)',
    url: d.finalUrl || d.url,
    state: d.state,
    sizeBytes: d.bytesReceived,
    // DownloadItem.startTime is already an ISO 8601 string.
    startTime: d.startTime ?? '',
    mime: d.mime ?? '',
  }))
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If `chrome.downloads`/`chrome.history` types are missing, confirm `@types/chrome` is installed (it already backs `tabs.ts`); no new dependency is needed.

- [ ] **Step 3: Commit**

```bash
git add src/platform/browsingData.ts
git commit -m "feat: browsing-data platform helpers (history, bookmarks, top sites, downloads)"
```

---

### Task 3: The four agent tools + toolset gating

**Files:**
- Modify: `src/tools/tools.ts` (imports at top; new tools inside `createAgentTools`'s `tools` object after `SearchMemory`, ~line 143; signature at line 35; gating near line 148)
- Modify: `src/ui/Chat.tsx` (import near line 12; call site at line 488, and the async block at ~line 479)

**Interfaces:**
- Consumes: `BrowsingCapability` from `../platform/permissions`; `getBrowsingHistory`, `getBookmarks`, `getTopSites`, `getDownloads` from `../platform/browsingData`; `grantedCapabilities` from `../platform/permissions`.
- Produces: `createAgentTools(requestApproval, tabAccess, granted)` — a **third** required parameter `granted: Set<BrowsingCapability>`.

- [ ] **Step 1: Add imports to `src/tools/tools.ts`**

After the existing import block (lines 1-5), add:

```ts
import { getBrowsingHistory, getBookmarks, getTopSites, getDownloads } from '../platform/browsingData'
import type { BrowsingCapability } from '../platform/permissions'
```

- [ ] **Step 2: Extend the `createAgentTools` signature**

Change line 35 from:

```ts
export function createAgentTools(requestApproval: ApprovalGate, tabAccess: TabAccess): ToolSet {
```

to:

```ts
export function createAgentTools(
  requestApproval: ApprovalGate,
  tabAccess: TabAccess,
  granted: Set<BrowsingCapability>,
): ToolSet {
```

- [ ] **Step 3: Add the four tool definitions**

Inside the `tools` object, immediately after the `SearchMemory` tool's closing `}),` (line 143) and before the object's closing `}` (line 144), insert:

```ts
    GetBrowsingHistory: tool({
      description:
        "Search the user's own browser history for pages they visited. Asks the user for permission first. Use to enrich a request when the user refers to something they read or visited earlier but did not share — e.g. \"that article I read last week\".",
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To find the article you read about X"'),
        query: z
          .string()
          .optional()
          .describe('Free-text terms to match page title/URL. Omit to list recent history.'),
        sinceDays: z.number().optional().describe('How many days back to search (default 7).'),
        maxResults: z.number().optional().describe('Max entries to return (default 50, max 200).'),
      }),
      execute: async ({ reason, query, sinceDays, maxResults }) => {
        const approved = await requestApproval({
          toolName: 'GetBrowsingHistory',
          summary: query
            ? `Search your browsing history for “${query}”`
            : 'Look through your recent browsing history',
          reason,
        })
        if (!approved) return DENIED
        const history = await getBrowsingHistory({ query, sinceDays, maxResults })
        return { history }
      },
    }),

    GetBookmarks: tool({
      description:
        "Search or list the user's bookmarks. Asks the user for permission first. Use when the user refers to a page they bookmarked or saved, or asks what they have bookmarked.",
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To find the docs you bookmarked"'),
        query: z
          .string()
          .optional()
          .describe('Terms to match bookmark title/URL. Omit to list recent bookmarks.'),
        maxResults: z.number().optional().describe('Max bookmarks to return (default 50, max 200).'),
      }),
      execute: async ({ reason, query, maxResults }) => {
        const approved = await requestApproval({
          toolName: 'GetBookmarks',
          summary: query ? `Search your bookmarks for “${query}”` : 'List your recent bookmarks',
          reason,
        })
        if (!approved) return DENIED
        const bookmarks = await getBookmarks({ query, maxResults })
        return { bookmarks }
      },
    }),

    GetTopSites: tool({
      description:
        "List the user's most-visited sites (their new-tab top sites). Asks the user for permission first. Use when the user asks about the sites they use most, or you need their frequent destinations to tailor an answer.",
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To see which sites you use most"'),
      }),
      execute: async ({ reason }) => {
        const approved = await requestApproval({
          toolName: 'GetTopSites',
          summary: 'See your most-visited sites',
          reason,
        })
        if (!approved) return DENIED
        const sites = await getTopSites()
        return { sites }
      },
    }),

    GetDownloads: tool({
      description:
        "Search the user's download history. Asks the user for permission first. Use when the user refers to a file they downloaded — e.g. \"the PDF I downloaded yesterday\" — or asks what they have downloaded.",
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To find the file you downloaded"'),
        query: z
          .string()
          .optional()
          .describe('Terms to match filename or URL. Omit to list recent downloads.'),
        state: z
          .enum(['complete', 'in_progress', 'interrupted'])
          .optional()
          .describe('Filter by download state.'),
        maxResults: z.number().optional().describe('Max downloads to return (default 25, max 100).'),
      }),
      execute: async ({ reason, query, state, maxResults }) => {
        const approved = await requestApproval({
          toolName: 'GetDownloads',
          summary: 'Look through your downloads',
          reason,
        })
        if (!approved) return DENIED
        const downloads = await getDownloads({ query, state, maxResults })
        return { downloads }
      },
    }),
```

- [ ] **Step 4: Gate the new tools by granted permission**

Immediately after the existing gating line (line 148):

```ts
  if (tabAccess !== 'all-tabs') delete tools.ViewOpenedTabs
```

add:

```ts
  // Browsing-data tools are hidden unless the user has granted the matching
  // optional permission — the model never sees a capability that is off.
  if (!granted.has('history')) delete tools.GetBrowsingHistory
  if (!granted.has('bookmarks')) delete tools.GetBookmarks
  if (!granted.has('topSites')) delete tools.GetTopSites
  if (!granted.has('downloads')) delete tools.GetDownloads
```

- [ ] **Step 5: Update the call site in `Chat.tsx`**

Add to the `../platform/permissions` import (create the import near the other `../platform` / `../tools` imports around line 12):

```ts
import { grantedCapabilities, type BrowsingCapability } from '../platform/permissions'
```

In the turn's async block, add a `granted` read just after the `memoryContext` line (line 479):

```ts
      const memoryContext = await getMemoryContext().catch(() => '')
      const granted = await grantedCapabilities().catch(() => new Set<BrowsingCapability>())
```

Then change the `tools:` line (488) from:

```ts
        tools: createAgentTools(requestApproval, settings.tabAccess),
```

to:

```ts
        tools: createAgentTools(requestApproval, settings.tabAccess, granted),
```

(The `granted` set is reused by Task 4's prompt note — leave it in scope.)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (Before Step 5 the build would fail with "Expected 3 arguments, but got 2" at the call site — confirming the signature change took effect.)

- [ ] **Step 7: Commit**

```bash
git add src/tools/tools.ts src/ui/Chat.tsx
git commit -m "feat: browsing-data agent tools gated by granted permissions"
```

---

### Task 4: Model awareness — system prompt + per-turn availability note

**Files:**
- Modify: `src/data/settings.ts` (`DEFAULT_SYSTEM_PROMPT`, ~lines 31-45)
- Modify: `src/ui/Chat.tsx` (new module-level `browsingInsightsNote` fn; system-prompt assembly at ~line 486)

**Interfaces:**
- Consumes: `BrowsingCapability` from `../platform/permissions` (already imported in Task 3); the `granted` set already read in Task 3 Step 5.
- Produces: module-level `function browsingInsightsNote(granted: Set<BrowsingCapability>): string` in `Chat.tsx`.

- [ ] **Step 1: Extend `DEFAULT_SYSTEM_PROMPT`**

In `src/data/settings.ts`, insert a new paragraph after the memory bullet block (after the `SearchMemory:` line, line 41) and before the `Each tool call asks the user for permission first` line (line 43):

```ts

With the user's permission you can also draw on their own browser data to enrich a request — but only use a tool that is listed as available this turn; if a browsing-insight tool is not listed, the user has that capability turned off.
- GetBrowsingHistory: find pages the user visited earlier ("that article I read last week").
- GetBookmarks: find pages the user bookmarked or saved.
- GetTopSites: the user's most-visited sites.
- GetDownloads: files the user downloaded.
Reach for these autonomously when the user refers to something they read, saved, or downloaded but did not share — look it up instead of asking them to paste it.
```

(Keep it inside the existing template literal; preserve the blank line before the following paragraph.)

- [ ] **Step 2: Add `browsingInsightsNote` to `Chat.tsx`**

At module scope in `src/ui/Chat.tsx` (after the imports, before the component), add:

```ts
// Which browsing-insight tool each capability exposes — used to tell the model,
// each turn, exactly which are usable so it never calls a disabled one.
const BROWSING_TOOL_NAMES: Record<BrowsingCapability, string> = {
  history: 'GetBrowsingHistory',
  bookmarks: 'GetBookmarks',
  topSites: 'GetTopSites',
  downloads: 'GetDownloads',
}

/** System-prompt suffix naming the browsing-insight tools available this turn. */
function browsingInsightsNote(granted: Set<BrowsingCapability>): string {
  const available = (Object.keys(BROWSING_TOOL_NAMES) as BrowsingCapability[])
    .filter((cap) => granted.has(cap))
    .map((cap) => BROWSING_TOOL_NAMES[cap])
  if (available.length === 0) {
    return '\n\nThe browsing-insight tools (history, bookmarks, top sites, downloads) are currently turned off; do not offer to use them.'
  }
  return `\n\nBrowsing-insight tools available this turn: ${available.join(', ')}.`
}
```

- [ ] **Step 3: Fold the note into the system prompt assembly**

Change the `system:` argument (line 486) from:

```ts
        system: `${settings.systemPrompt}${accessNote}${memoryContext ? `\n\n${memoryContext}` : ''}`,
```

to:

```ts
        system: `${settings.systemPrompt}${accessNote}${browsingInsightsNote(granted)}${memoryContext ? `\n\n${memoryContext}` : ''}`,
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/settings.ts src/ui/Chat.tsx
git commit -m "feat: teach the model about browsing-insight tools and per-turn availability"
```

---

### Task 5: "Browsing insights" Settings section

**Files:**
- Modify: `src/ui/Settings.tsx` (import; render `<BrowsingInsightsSection />` after the Tab-visibility block ~line 167; new component near `ShortcutSection` ~line 202)
- Modify: `src/ui/styles.css` (append toggle-row styles after the `.access-desc` rule, ~line 949)

**Interfaces:**
- Consumes: `BROWSING_CAPABILITIES`, `type BrowsingCapability`, `grantedCapabilities`, `requestCapabilities`, `removeCapabilities` from `../platform/permissions`.
- Produces: a self-contained `BrowsingInsightsSection` component (no props; acts on Chrome permissions live, independent of the `draft`/Save flow).

- [ ] **Step 1: Import the permission helpers in `Settings.tsx`**

After the existing imports (lines 1-7), add:

```ts
import {
  BROWSING_CAPABILITIES,
  type BrowsingCapability,
  grantedCapabilities,
  requestCapabilities,
  removeCapabilities,
} from '../platform/permissions'
```

- [ ] **Step 2: Render the section**

In the returned JSX, immediately after the closing `</label>` of the `all-tabs` access option (line 167) and before `<ShortcutSection />` (line 169), add:

```tsx
      <BrowsingInsightsSection />

```

- [ ] **Step 3: Add the `BrowsingInsightsSection` component**

Add this component next to `ShortcutSection` (e.g. after line 241, at module scope):

```tsx
// Browsing-data capabilities are Chrome optional permissions, not part of
// Settings — so this section acts immediately (grant/revoke on toggle), not on
// Save, and reads its state live from chrome.permissions. It stays in sync when
// the user grants/revokes elsewhere (e.g. chrome://extensions).
const CAPABILITY_LABELS: Record<BrowsingCapability, string> = {
  history: 'Browsing history',
  bookmarks: 'Bookmarks',
  topSites: 'Top sites',
  downloads: 'Downloads',
}

function BrowsingInsightsSection() {
  const [granted, setGranted] = useState<Set<BrowsingCapability>>(new Set())

  useEffect(() => {
    const refresh = () => grantedCapabilities().then(setGranted).catch(() => {})
    refresh()
    chrome.permissions.onAdded.addListener(refresh)
    chrome.permissions.onRemoved.addListener(refresh)
    return () => {
      chrome.permissions.onAdded.removeListener(refresh)
      chrome.permissions.onRemoved.removeListener(refresh)
    }
  }, [])

  // request/remove must be called from this click handler (the user gesture).
  // We re-read afterward so a denied prompt reverts the checkbox from state.
  async function toggle(caps: BrowsingCapability[], on: boolean) {
    if (on) await requestCapabilities(caps)
    else await removeCapabilities(caps)
    setGranted(await grantedCapabilities())
  }

  const allOn = BROWSING_CAPABILITIES.every((c) => granted.has(c))
  const missing = BROWSING_CAPABILITIES.filter((c) => !granted.has(c))

  return (
    <>
      <h2>Browsing insights</h2>
      <p className="hint">
        Let the agent look up your history, bookmarks, top sites and downloads to enrich answers.
        Each lookup still asks for permission. Granting happens here and can be revoked anytime.
      </p>
      <label className="toggle-row master">
        <div className="access-title">Enable all browsing insights</div>
        <input
          type="checkbox"
          checked={allOn}
          onChange={(e) => void toggle(e.target.checked ? missing : BROWSING_CAPABILITIES, e.target.checked)}
        />
      </label>
      {BROWSING_CAPABILITIES.map((cap) => (
        <label className="toggle-row" key={cap}>
          <div className="access-desc">{CAPABILITY_LABELS[cap]}</div>
          <input
            type="checkbox"
            checked={granted.has(cap)}
            onChange={(e) => void toggle([cap], e.target.checked)}
          />
        </label>
      ))}
    </>
  )
}
```

- [ ] **Step 4: Add toggle-row styles**

Append to `src/ui/styles.css` after the `.access-desc` rule (after line 949):

```css
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  margin-bottom: 6px;
  cursor: pointer;
}

.toggle-row.master {
  margin-bottom: 10px;
}

.toggle-row input {
  accent-color: var(--accent);
  width: 16px;
  height: 16px;
  flex: none;
  cursor: pointer;
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/Settings.tsx src/ui/styles.css
git commit -m "feat: Browsing insights settings section (master + per-capability toggles)"
```

---

### Task 6: Build + manual browser verification

**Files:** none (verification only).

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: `tsc --noEmit` passes, `vite build` writes `dist/`.

- [ ] **Step 2: Reload the extension**

Load/reload the unpacked extension: `chrome://extensions` → Developer mode → reload the extension (or Load unpacked → `dist/`).

- [ ] **Step 3: Verify the master toggle**

Open the side panel → Settings → "Browsing insights". Toggle **Enable all browsing insights** on.
Expected: one combined Chrome permission prompt listing history/bookmarks/top sites/downloads; on Allow, all four child switches turn on.

- [ ] **Step 4: Verify per-capability toggles**

Turn the master off (all four revoked), then toggle a single capability (e.g. **Downloads**) on.
Expected: a Chrome prompt for that one permission; only that switch turns on; master stays off.

- [ ] **Step 5: Verify autonomous tool use + approval + gating**

With **Browsing history** granted, ask the agent something like: "What was that article about React hooks I read recently?"
Expected: the model calls `GetBrowsingHistory`; the inline approval card shows a summary like *Search your browsing history for "React hooks"* with the model's reason; on Allow, results return and the answer references them. Deny once and confirm the model reports it was denied rather than fabricating.

- [ ] **Step 6: Verify hidden-when-off**

Revoke **Browsing history** from the Settings toggle (or from `chrome://extensions`). Confirm the Settings switch updates to off, then ask the same question.
Expected: the model does not call `GetBrowsingHistory` (the tool is absent); its answer reflects that browsing history is turned off.

- [ ] **Step 7: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore: verify browsing-data tools end to end"
```

(If no fixups were needed, skip this step.)

---

## Self-Review

**Spec coverage:**
- Four tools (`GetBrowsingHistory`/`GetBookmarks`/`GetTopSites`/`GetDownloads`) → Task 3. ✅
- Compact return shapes + timestamp normalization + caps → Task 2. ✅
- `optional_permissions` in manifest → Task 1 Step 1. ✅
- `permissions.ts` grant/remove/query → Task 1 Step 2. ✅
- Source-of-truth = granted permission, no new `Settings` field → Tasks 1 & 5 (section reads live, never touches `draft`). ✅
- Tools hidden until granted (mirrors `ViewOpenedTabs`) → Task 3 Step 4. ✅
- Per-call approval gate → Task 3 Step 3 (every `execute` calls `requestApproval`, returns `DENIED`). ✅
- Turn-start `grantedCapabilities()` read + pass into `createAgentTools` → Task 3 Step 5. ✅
- Dynamic availability note in prompt → Task 4. ✅
- `DEFAULT_SYSTEM_PROMPT` paragraph → Task 4 Step 1. ✅
- Master + per-capability toggles, live sync via `onAdded`/`onRemoved`, gesture-driven request → Task 5. ✅
- Read-only scope, no onboarding change → respected (no delete/clear tools; onboarding untouched). ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✅

**Type consistency:** `BrowsingCapability`, `BROWSING_CAPABILITIES`, `grantedCapabilities`, `requestCapabilities`, `removeCapabilities` (plural array forms — note this refines the spec's singular `requestCapability`/`removeCapability` names) are used identically across Tasks 1/3/4/5. `createAgentTools(requestApproval, tabAccess, granted)` third-param `Set<BrowsingCapability>` matches its Task 3 call site. Helper return shapes (`HistoryEntry`/`BookmarkEntry`/`TopSiteEntry`/`DownloadEntry`) are defined once in Task 2 and consumed only via the tool wrappers. ✅
