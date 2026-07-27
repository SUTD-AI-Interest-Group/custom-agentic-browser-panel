# Tab management, semantic grouping and tab understanding

**Date:** 2026-07-28
**Status:** approved, implementing

## Problem

Lychee can list open tabs (`ReadTabs`) and navigate between them (`NavigateTab`), and
nothing else. It cannot tell what a tab is *about* without reading the whole page, it
cannot file tabs into Chrome tab groups, and it cannot close anything. A user with sixty
tabs open — the case where help is actually worth something — is exactly the case the
current tools serve worst: listing sixty titles and URLs is cheap but semantically thin,
and reading sixty pages is unaffordable.

Three scenarios must all work, off one shared substrate:

1. **Tab bankruptcy cleanup.** "I have 60 tabs, sort this out." Cluster into named groups,
   flag duplicates and dead tabs, propose closures.
2. **Recall across tabs.** "Which tab had the pricing table?" Answer without reading 60 pages.
3. **Task-scoped workspaces.** "Group everything for my thesis chapter." Grouping as a way
   of scoping attention, not just tidying.

## Non-goals

- No new side-panel UI. This is agent tools only; the human surface is the chat plus
  Chrome's own native tab-group affordances.
- No background/ambient auto-grouping. Every change is a response to something the user asked for.
- No cross-window tab moves. No re-filing of groups the user made by hand.
- No second LLM pass. The chat model is the semantic engine; the substrate only feeds it.

## Design

### Tab understanding: the gist probe

`ReadTabs` gains `mode: 'gist'` beside the existing `text` and `dom`. It returns one
compact record per tab rather than page bodies:

```ts
interface TabRecord {
  tabId: number
  title: string
  host: string
  url: string
  gist: string          // '' when the tab was not probed
  windowId: number
  group?: { id: number; title: string; color: string }
  pinned: boolean
  audible: boolean
  discarded: boolean
  blank: boolean        // new-tab page / about:blank — a "dead" tab
  active: boolean
  lastAccessed?: number // Chrome 121+; omitted below that
  skipped?: string      // why no gist was taken
}
```

`gist` comes from a self-contained injected extractor, in priority order:
`og:description` → `meta[name=description]` → first `<h1>` → first ~200 chars of
`body.innerText`. Clamped to `GIST_CHARS` (180) after whitespace collapsing. Sixty tabs
cost roughly 10k characters — one tool call, no page bodies.

**Probe eligibility is decided before any injection**, by the pure `planTabProbe()`:

| Skipped | Why |
|---|---|
| `discarded` tabs | `chrome.scripting.executeScript` **wakes** a discarded tab. Probing sixty would reload every one — a RAM spike and a visibly thrashing browser. This is the single most important rule here. |
| `chrome://`, `chrome-extension://`, `edge://`, `about:`, `devtools://`, `view-source:` | Not scriptable. |
| `chromewebstore.google.com`, `chrome.google.com/webstore` | Chrome refuses injection. |
| past `TAB_GIST_LIMIT` (100) | Cost ceiling. |

Skipped tabs still appear in the result with title, URL and a `skipped` reason. The model
is never silently short a tab — it can see that tab 41 exists and that it was asleep.

Injection runs in chunks of `PROBE_CONCURRENCY` (8) so a sixty-tab probe does not stall
the browser. A single tab's failure yields `skipped`, never a rejected batch.

Alongside the records, the result carries `duplicates`: clusters of tabs sharing a
normalized URL (fragment dropped, trailing slash dropped, `utm_*` / `fbclid` / `gclid` /
`ref` stripped, host lowercased, `www.` dropped). Computing this in code rather than
asking the model to eyeball sixty URLs is both cheaper and more reliable.

Using `mode:'gist'` self-expands `GroupTabs` and `CloseTabs` into the turn's `activeNames`,
the way `RequestPageControl` expands the page-control cluster. Loading is not permission:
each tool still raises its own approval card when called.

### Grouping

`GroupTabs({ groups: [{ name, color, tabIds }], reason })`, plus an `ungroup` action for
groups the agent itself created earlier in the conversation.

The pure `planGrouping()` rewrites what the model asked for into what is legal:

- **Ungrouped tabs only.** A tab already in a group is dropped from the assignment and
  reported back. The user's own filing is context, never raw material.
- **Split per window.** `chrome.tabs.group` cannot span windows, and moving tabs between
  windows is jarring and hard to undo. A proposed group whose tabs live in three windows
  becomes three Chrome groups with the same name and color.
- **Each tab lands in at most one group** — first assignment wins, later duplicates dropped.
- Unknown / stale tab ids dropped; pinned tabs dropped (Chrome cannot group a pinned tab).
- Group names clamped to 40 chars; colors validated against Chrome's nine-color enum with a
  deterministic rotation as fallback so a model that invents `"teal"` still gets a group.
- Groups reduced to fewer than 2 tabs are dropped — a one-tab group is noise.

Everything dropped comes back in the tool result as `rejected: [{tabId, reason}]`, so the
model can explain itself rather than silently under-delivering.

### Closing, and undo

`CloseTabs({ action: 'close' | 'reopen', tabIds?, reason })`.

The pure `planClosure()` refuses, with a reason the model sees:

- the active tab (closing the tab under the user's cursor is never what they meant),
- pinned tabs,
- the last remaining tab of a window (Chrome would close the window),
- unknown / stale ids.

Before removal, the surviving set is stashed to `chrome.storage.local` under
`closedTabs:last` as `{ at, tabs: [{ url, title, windowId, index, pinned }] }`, capped at
`MAX_STASH` (100). `action:'reopen'` recreates them — most-recent stash only, one level of
undo, cleared once consumed. This is deliberately simpler than `chrome.sessions`: no extra
permission, and reopening a URL is good enough where restoring per-tab history is not.

### The batch approval card

`ApprovalRequest` gains two optional fields:

```ts
items?: { title: string; host: string; note?: string }[]
danger?: boolean
```

`ApprovalCard` renders `items` as a scrollable list under the reason (max-height ~180px),
and `danger` tints the card and the confirm button with the destructive color. Both
`GroupTabs` and `CloseTabs` populate `items`; only `CloseTabs` sets `danger`.

`CloseTabs` also sets `once: true`, suppressing "Allow this chat". A standing allowance to
close tabs would mean later closures happen with no card at all — unacceptable for the one
destructive action in this set. `GroupTabs` is reversible and offers the normal allowance.

A third field, `needsPermissions?: string[]`, is requested from inside the Allow click —
see the permission section below.

### Gating and filtering

All three tools are removed when `tabAccess !== 'all-tabs'`, alongside the existing
`delete tools.ReadTabs`. In active-tab mode the model never sees a capability that could
enumerate, group, or close other tabs. The per-tool Never/Ask/Always policy applies on top,
unchanged.

### The `tabGroups` permission

**Corrected during implementation.** The original assumption — that `tabGroups` rides under
`tabs` and shows no warning — is wrong. Chrome's permissions reference lists it with the
warning *"View and manage your tab groups."* Shipping it as a **required** permission would
therefore disable the extension for every existing user pending re-consent, which is far
too high a price for one feature.

It is declared in `optional_permissions` instead. Two facts make this cheap:

- `chrome.tabs.group()` and `chrome.tabs.ungroup()` need **no** permission. Only
  `chrome.tabGroups.query/update` — naming and coloring — require `tabGroups`. Since a
  nameless grey group defeats the entire point of *semantic* grouping, `GroupTabs` treats
  the permission as mandatory rather than degrading to unnamed groups.
- `chrome.permissions.request()` requires a user gesture, and **the approval card's Allow
  button is one**. So `GroupTabs` sets `needsPermissions: ['tabGroups']` and
  `settleApproval` issues the request as its first statement — ahead of any `await`, or the
  gesture is spent. Declining Chrome's dialog declines the tool call.

The user therefore grants it exactly when it is first needed, with the reason on screen,
and never has to find a Settings toggle. `buildTabIndex`'s `chrome.tabGroups.query()` is
wrapped in try/catch and simply omits group metadata until the permission exists.

`tab.lastAccessed` requires Chrome 121 but the manifest floor is 116, so the field is
treated as optional and omitted when absent rather than bumping the floor.

## File layout

| File | Role |
|---|---|
| `src/platform/tabIndex.ts` | **new.** `buildTabIndex()` Chrome shell; pure `planTabProbe`, `clampGist`, `normalizeUrl`, `findDuplicates` exported alongside. |
| `src/platform/tabIndex.test.ts` | **new.** Tests for the pure functions. |
| `src/platform/tabGroups.ts` | **new.** Thin shell over `chrome.tabs.group` / `chrome.tabGroups.update` / `chrome.tabs.ungroup`. |
| `src/tools/tabPolicy.ts` | **new.** Pure, Chrome-free. `planGrouping()`, `planClosure()`. The safety boundary, mirroring `browsePolicy.ts`. |
| `src/tools/tabPolicy.test.ts` | **new.** Exhaustive — this file is the whole safety story. |
| `src/platform/tabs.ts` | `closeTabs()`, `reopenClosedTabs()`, and the undo stash. |
| `src/tools/tools.ts` | `ReadTabs` gains `gist`; new `GroupTabs`, `CloseTabs`; `ApprovalRequest.items` / `.danger`; tabAccess filtering. |
| `src/ui/Chat.tsx` | `ApprovalCard` item list; disclosure note; tool-part labels. |
| `src/ui/styles.css` | Approval item-list and danger styles. |
| `public/manifest.json` | `+ "tabGroups"` in `optional_permissions`. |
| `README.md` | Tool table rows. |

## Testing

Pure logic is unit-tested (`npm test`): probe planning and its skip reasons, gist clamping,
URL normalization and duplicate clustering, grouping legality (cross-window split, grouped/
pinned/unknown rejection, color fallback, single-tab drop, one-group-per-tab), closure
refusals (active, pinned, last-in-window, unknown).

The Chrome-coupled shells and the approval card are verified by hand per `CLAUDE.md`:
`npm run build`, reload the unpacked extension, then exercise a real sixty-tab window —
gist probe with discarded tabs present, a grouping run, a close run, and the reopen.
