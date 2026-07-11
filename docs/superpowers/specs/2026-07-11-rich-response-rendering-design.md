# Rich response rendering — design

**Date:** 2026-07-11
**Status:** Approved (design), pending implementation plan

## Problem

Assistant messages render through `AssistantText` (`src/ui/Chat.tsx`), which
splits text into `markdown | images` via `splitImageBlocks` and renders each
(`Markdown` = marked → DOMPurify → `dangerouslySetInnerHTML`, or
`ImageCarousel`). Everything that isn't an image run is a flat wall of markdown:
bare links render as plain `<a>`, code blocks have no copy affordance or
highlighting, JSON is an undifferentiated code block, long pastes dominate the
panel, and tables are unstyled. We want richer, more scannable rendering for
these other response objects — without a backend and without bloating the
initial bundle.

## Goals

- **Link preview cards** for standalone links (hybrid: instant favicon/domain,
  lazy OpenGraph upgrade), with a privacy toggle.
- **Code block polish**: language label, copy button, lazy-loaded syntax
  highlighting, and auto-collapse for long blocks.
- **Structured data**: standalone JSON → collapsible tree; table polish (zebra,
  sticky header, horizontal scroll).
- **KaTeX display-math robustness** (a reported issue; see Phase 1).
- Stay client-side, MV3-CSP-safe, and keep the initial `sidepanel.js` from
  growing (highlighter is lazy-loaded into its own chunk).

## Non-goals

- Tool-result cards (`ToolPill` JSON dumps stay as-is — not selected).
- Full-fidelity markdown-it-style rendering; we keep `marked`.
- Server-side link unfurling or a third-party preview API.

## Decisions (from brainstorming)

- **Link preview data:** hybrid — cheap favicon/domain card immediately, lazy
  OpenGraph upgrade if a client-side fetch succeeds.
- **Highlighting:** lightweight, **lazy-loaded** (`import()`), so it lands in a
  separate chunk, not the initial bundle.
- **Structured data v1:** all three — auto-collapse long blocks, table polish,
  JSON→tree.
- **Delivery:** one spec, phased plan.

## Architecture

The interactive widgets (JSON tree, link cards, collapse toggles) need React
interactivity that `dangerouslySetInnerHTML` can't provide. So the core change
is to **generalize the block segmenter** and render each block type with a
dedicated component:

```
AssistantText(text)
  └─ splitBlocks(text) → ordered segments:
       ├─ 'images'   → ImageCarousel     (existing)
       ├─ 'links'    → LinkCardStack      (new)
       ├─ 'json'     → JsonTree           (new)
       └─ 'markdown' → Markdown           (prose, inline code, tables, KaTeX)
                         └─ useEffect: enhance code blocks
                              (language label, copy, lazy highlight, collapse)
```

- **Prose stays in `marked`**, so KaTeX, inline links, lists, and tables keep
  working unchanged. Only *standalone* link lines and *standalone* JSON blocks
  are pulled out into components; anything inline in prose is untouched.
- **Code-block enhancements happen in a post-render `useEffect`** over
  `.markdown pre` — the markdown → sanitize → inject path is not rewritten.
- **The highlighter is dynamically imported**, so it's a separate lazy chunk.
- **Table polish is pure CSS**; a `marked` table renderer wraps `<table>` in a
  scroll container.

### File structure

- **Create** `src/ui/blocks.ts` — `splitBlocks(text): Segment[]` generalizing
  `imageBlocks.ts` (image-run detection stays; adds standalone-link-run and
  standalone-JSON detection). `imageBlocks.ts` is folded in and removed, or kept
  as a thin re-export — decided in the plan.
- **Create** `src/ui/LinkCard.tsx` — one card (favicon/domain instant, lazy OG
  upgrade) and `LinkCardStack` for a run.
- **Create** `src/platform/linkPreview.ts` — `getLinkPreview(url)`: memory +
  `chrome.storage.local` cache, client-side fetch + `DOMParser` OG extraction,
  timeout + graceful failure.
- **Create** `src/ui/JsonTree.tsx` — recursive collapsible tree + copy.
- **Create** `src/ui/codeEnhance.ts` — the `useEffect` body: header bar (lang +
  copy), lazy `highlight.js`, and long-block collapse.
- **Modify** `src/ui/Markdown.tsx` — run the code enhancer after render; add a
  `marked` table renderer that wraps tables in `.table-scroll`.
- **Modify** `src/ui/Chat.tsx` — `AssistantText` uses `splitBlocks`.
- **Modify** `src/data/settings.ts` (+ a settings tab) — add
  `fetchLinkPreviews: boolean` (default `true`) with a UI toggle.
- **Modify** `src/ui/styles.css` — cards, code header, JSON tree, table polish,
  collapse.

## Components

### Phase 1 — KaTeX display-math robustness

The reported raw-`$$` screenshot could not be reproduced against current merged
code (a full-message pipeline run rendered 31/31 equations, 0 literal `$$`),
which points to a **stale build**. So:

1. **Verify by reload first** — rebuild `dist/`, reload the unpacked extension,
   re-ask; confirm whether the issue persists.
2. **If a real gap remains** (or as hardening regardless): the one reproducible
   failure is `$$…$$` glued to the very start of a line with no preceding blank
   line. Add a **guarded normalization** (reusing the code-guard from
   `mathDelimiters.ts`) that ensures a display `$$…$$` run is blank-line
   isolated so `marked-katex-extension`'s block rule always tokenizes it. Do
   **not** use `nonStandard: true` (it would reintroduce `$5 … $10` currency
   false-positives). Ship with a `npx tsx` regression check covering the
   line-start case and confirming inline `$…$` and currency text are untouched.

### Phase 2 — Block segmenter (`splitBlocks`)

Generalize `imageBlocks.ts`. A **standalone** block is a line (optionally
bulleted) whose entire content is one recognizable object:

- **Image run** (existing): 2+ consecutive image-URL lines → `images`.
- **Link run** (new): 1+ consecutive standalone *non-image* link lines (bare
  `http(s)` URL, `<url>` autolink, or `[text](url)`) → `links`, carrying
  `{ url, text }` per item. A single standalone link becomes a single card
  (links benefit from a lone card more than images do).
- **JSON block** (new): a fenced ```` ```json ```` block, or a ```` ``` ````
  block whose trimmed body `JSON.parse`s to an object/array → `json`, carrying
  the parsed value + raw text.
- Everything else → `markdown` (unchanged path).

Ordering is preserved; inline links/JSON inside prose stay in the markdown
segment. Wire `AssistantText` to render each segment type. Links and JSON can
fall back to markdown rendering until their components land, so Phase 2 is a
safe no-visible-change increment.

### Phase 3 — Link cards (hybrid)

- **`LinkCard`**: renders favicon (existing `Favicon`) + hostname + link text
  immediately. On mount, calls `getLinkPreview(url)`; on success, upgrades to
  show OG `title`, `description`, and `og:image` (via `<img>`). All OG text is
  inserted as React text (auto-escaped) — never `dangerouslySetInnerHTML`.
- **`getLinkPreview(url)`** (`src/platform/linkPreview.ts`):
  - In-memory `Map` cache (dedupe within a render/session) over a
    `chrome.storage.local` cache (`linkPreview:<url>` → `{ data, ts }`, TTL ~7
    days; failures cached briefly as `null` so we don't refetch a 404 every
    render).
  - Fetch: `fetch(url, { signal: AbortSignal.timeout(6000), redirect: 'follow' })`
    → `text()` → `new DOMParser().parseFromString(html, 'text/html')`. Read
    `meta[property="og:title"|"og:description"|"og:image"|"og:site_name"]`,
    falling back to `<title>` and `meta[name=description]`. Resolve a relative
    `og:image` against the final URL. Return `{ title, description, image,
    siteName } | null`.
  - `<all_urls>` host permission exempts these cross-origin reads from CORS, so
    no proxy is needed. Errors/timeouts/blocked sites → `null` → card stays the
    cheap favicon/domain form.
- **Privacy:** gated by `settings.fetchLinkPreviews` (default `true`). When
  `false`, `getLinkPreview` short-circuits to `null` and no network request is
  made — cards render favicon/domain only. Exposed as a labeled toggle in
  Settings.

### Phase 4 — Code blocks

Enhance every `.markdown pre` after render (`src/ui/codeEnhance.ts`, called from
`Markdown`'s `useEffect`, re-run on `text` change; idempotent/guarded so a
re-run doesn't double-wrap):

- **Header bar**: language label (from the `language-xxx` class `marked` emits)
  + a **copy** button (copies the raw code text; transient "Copied" state).
- **Lazy highlighting**: `const hljs = (await import('highlight.js/lib/core'))`
  with a curated common-language set registered (js, ts, jsx/tsx, json, bash,
  html, css, python, and a sensible fallback via `highlightAuto`). Applied to
  each `code` element. Because it's async, code shows unhighlighted for a frame,
  then upgrades — acceptable and keeps the highlighter out of the initial
  bundle. Guard against highlighting a block twice.
- **Collapse**: if a block's rendered height exceeds a threshold (~360px), clamp
  it with a fade and a "Show more / Show less" toggle.

### Phase 5 — Structured data

- **JSON tree** (`src/ui/JsonTree.tsx`): recursive component — objects/arrays are
  expandable rows (collapsed past a depth for large values), primitives shown
  inline with type coloring; a copy-raw button. Rendered for `json` segments
  from `splitBlocks`.
- **Table polish**: a `marked` table renderer wraps `<table>` in
  `<div class="table-scroll">`; CSS adds zebra rows, a sticky header, and
  `overflow-x: auto` on the wrapper (so a wide table scrolls within its bubble,
  consistent with the KaTeX `.katex-display` fix).

## Edge cases & security

- **Link false-positives:** only *whole-line* links become cards; inline links
  stay `<a>`. A trailing-punctuation URL (`https://x.com.`) trims the punctuation
  for the href.
- **OG fetch safety:** response parsed with `DOMParser` (no script execution);
  only `meta`/`title` **text** is read; `og:image` loaded via `<img>` (a known,
  accepted tracking-pixel surface that the privacy toggle disables). No fetched
  HTML is ever injected.
- **JSON detection:** must not swallow a fenced non-JSON block; only treat a
  block as JSON when `JSON.parse` succeeds on the trimmed body. Very large JSON
  (> a size cap) falls back to a normal code block to avoid a huge tree.
- **Code enhancer idempotency:** guard with a `data-enhanced` marker so React
  re-renders / streaming updates don't stack multiple headers.
- **Streaming:** blocks are re-segmented each token; a not-yet-closed fence or
  link line renders as markdown until complete, then snaps — same behavior as
  the image carousel today.
- **Bundle:** only `highlight.js` is added, dynamically imported. Card/tree/
  segmenter code is small and static.

## Testing / verification

No unit-test suite (per CLAUDE.md); verify via `npm run build` + `/verify-extension`,
with `npx tsx` checks for pure logic:

- **`splitBlocks`** (`npx tsx` table): images, link runs (single + multi), JSON
  blocks, mixed, and inline-link/inline-JSON-stay-markdown cases.
- **`linkPreview`** OG parsing: a `npx tsx` check feeding sample HTML strings to
  the parser (extract the fetch/DOMParser core into a pure `parseOpenGraph(html,
  baseUrl)` so it's testable without network).
- **KaTeX normalization** (Phase 1): `npx tsx` regression for the line-start
  case + currency/inline untouched.
- **Browser** (`/verify-extension`): link cards upgrade with OG; privacy toggle
  off → no network (verify in DevTools Network tab); code copy + highlight +
  collapse; JSON tree expand/collapse; wide table scrolls in its bubble; the
  circle question renders (Phase 1).

## Implementation notes

- Build in a git **worktree** (this design and plan are authored there), with
  pathspec-scoped commits; no Claude attribution trailers.
- Phase order: 1 (KaTeX) → 2 (segmenter) → 3 (link cards) → 4 (code) → 5
  (structured). Each phase is independently shippable; the segmenter (Phase 2)
  degrades to markdown for not-yet-built block types.

## Sources

- OpenGraph protocol — https://ogp.me/
- highlight.js (lazy core import) — https://highlightjs.org/
