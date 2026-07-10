# DOM access + tab navigation tools

**Date:** 2026-07-10
**Status:** Approved

## Problem

The agent can read a tab's *visible text* (`ViewCurrentTab`, `ViewOpenedTabs` →
`body.innerText`) but has no view of the page's **DOM structure** — tags,
attributes, links, form fields — and no way to **switch or drive tabs** on the
user's behalf. Structured requests ("find the login form", "what does the nav
link to", "open the docs tab and go to the API page") are impossible today.

## Solution

Add three tools to `createAgentTools()` in `src/tools/tools.ts`, each routed
through the existing `requestApproval` gate (architecture invariant — every tool
is human-in-the-loop). Two expose a **cleaned HTML** view of the DOM; one drives
tab navigation. All page reads reuse the existing
`chrome.scripting.executeScript` function-injection pattern — no content-script
bundle, no manifest changes (`scripting`/`tabs`/`activeTab`/`<all_urls>` are
already granted).

### Tools

- **`GetActiveTabDOM`** `{ reason }` — cleaned DOM of the tab the user is on.
  Available in every tab-access mode.
- **`GetAllDOM`** `{ reason, tabIds? }` — with no `tabIds`, lists open tabs
  (`listOpenTabs()`); with `tabIds`, returns cleaned DOM for each at a per-tab
  cap. Enumerates other tabs, so it is **deleted unless
  `tabAccess === 'all-tabs'`**, mirroring `ViewOpenedTabs`.
- **`NavigateTab`** `{ reason, action, tabId?, url? }` where
  `action ∈ { activate, goto, open }`:
  - `activate` — focus an existing tab by `tabId` (+ focus its window)
  - `goto` — load `url` in `tabId` (defaults to the active tab)
  - `open` — open a new tab at `url`
  A Zod `.refine` enforces the required args per action (`goto`/`open` need
  `url`; `activate` needs `tabId`). Available in every mode; the approval card
  names the exact action so the user is the backstop.

### Platform layer — `src/platform/tabs.ts` (extend)

- **`extractPageDom()`** — self-contained injected function. Clones
  `document.documentElement`, then:
  - removes noise nodes: `script, style, noscript, svg, canvas, template,
    iframe, link, meta` + HTML comments
  - strips every attribute except a semantic allowlist: `href, src, alt, title,
    id, class, role, name, type, value, placeholder, aria-*, for, action,
    method, rel, target`
  - collapses runs of whitespace
  - returns `{ title, url, dom }`
- **`readTabDom(tabId, maxChars)`** — mirrors `readTabContent`: runs the
  injection, truncates to `maxChars`, returns
  `TabDom { tabId, title, url, dom, truncated, error? }`. Unscriptable pages
  (`chrome://`, Web Store, some PDFs) return a friendly `error` instead of
  throwing.
- **`navigateTab(action, { tabId?, url? })`** — thin wrapper over
  `chrome.tabs.update` / `chrome.tabs.create`; returns the resulting
  `{ tabId, url, title }`.

### Caps

- `MAX_DOM_CHARS = 40_000` for a single active tab (`GetActiveTabDOM`).
- `15_000` per tab for `GetAllDOM` (bounds aggregate context across many tabs).
- DOM is denser than plain text, hence larger than the existing 25k text cap.

## Non-goals

- No clicking / typing / page interaction — that is the parallel
  `browser-use-page-control` worktree's scope; this work stays out of its lane.
- No persistent content script.
- No new permissions.

## Verification

`npm run build` (typecheck + build), reload the unpacked extension, then in the
side panel: (1) ask the agent to inspect the current page's DOM → approve →
confirm cleaned HTML comes back; (2) in all-tabs mode, ask about another tab via
`GetAllDOM`; (3) ask it to switch to / open a tab via `NavigateTab` and confirm
the browser reacts. Covered by the `/verify-extension` skill.

## Git

A parallel `browser-use-page-control` session is live in its own worktree/branch.
This change is additive to two source files; the commit is pathspec-scoped to
only the files it touches so nothing collides.
