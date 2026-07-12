# Agent screenshot tool — webpage & element-level capture

**Status:** approved, implementing
**Date:** 2026-07-13

## Problem

The agent can read a page as text (`ReadPage` mode `text`/`dom`) and as an indexed list of
*interactive* elements (mode `elements`, plus a set-of-marks screenshot). It cannot look at
anything else. Charts, diagrams, `<figure>`s, tables, rendered layout, and visual state that
text extraction flattens or loses are invisible to it, and after a `ControlPage` action it has
no way to confirm the UI actually changed beyond re-reading the element registry.

We want a `Screenshot` tool the agent invokes to *see* — the viewport, a specific element, or
the full page — serving four jobs:

1. **See what text can't say** — charts, images, rendered layout.
2. **Verify its own actions** — confirm a click landed; catch modals, errors, CAPTCHAs.
3. **Produce artifacts for the user** — shots shown in chat and downloadable.
4. *(follow-on spec)* **Evidence for research reports.**

Scope of THIS spec: the shared capture core + the foreground agent tool + the chat UI (1–3).
Research integration (4) reuses the core but runs in the offscreen host through the SW render
broker; it gets its own spec.

## Two facts that constrain everything

**Images reach the model through exactly one channel.** A tool result *cannot* carry an image:
the OpenAI-compatible adapter serializes a tool result's `media` part to plain text. So
`lookResult` (`src/tools/tools.ts`) pushes its set-of-marks PNG onto a shared `imageQueue`, and
`runAgentTurn`'s `prepareStep` (`src/agent/agent.ts`) drains it into a synthetic `user` message
before the next step — the one channel the adapter turns into an `image_url`. Any screenshot
must ride that rail.

**`chrome.tabs.captureVisibleTab` only ever returns the visible viewport of the active tab.**
Anything taller requires scroll-and-stitch. (`chrome.debugger` +
`Page.captureScreenshot({captureBeyondViewport:true})` would do it in one call but requires the
`debugger` permission, which shows a persistent *"Extension is debugging this browser"* infobar.
Rejected — hostile in a consumer extension.)

## Architecture

| File | Role |
|---|---|
| `src/platform/regionIndex.ts` *(new)* | Visual-region perception — the element-level address space |
| `src/platform/screenshot.ts` *(new)* | Capture engine — viewport / element / fullpage, stitch + tile |
| `src/data/screenshots.ts` *(new)* | `agent-chat-screenshots` IndexedDB store + pruning |
| `src/agent/agent.ts` | `imageQueue` entries gain captions |
| `src/tools/tools.ts` | `Screenshot` tool; `ReadPage` mode `regions`; vision gating |
| `src/ui/Chat.tsx` | Resolve vision capability; render the shot card |
| `src/platform/capture.ts` | Export the semantic-snap heuristic, shared with `regionIndex` |

### 1. Visual-region index (`regionIndex.ts`)

Mirrors `domIndex.ts` structurally, with three deliberate differences:

- **Indexes the whole document, not the viewport.** `domIndex.isVisible` rejects off-screen
  elements because you cannot click what you cannot see. You *can* screenshot them — you scroll
  first. Regions are collected document-wide.
- **Rects are re-resolved at capture time.** The stored rect is for ranking and reporting only.
  At capture the node is re-found by its `data-agent-region` stamp and its **live** viewport rect
  is read, because scrolling triggers lazy-load and sticky reflow and a stale rect crops the
  wrong pixels. (Same re-find-by-attribute discipline CLAUDE.md mandates for injected functions.)
- **Selects for content, not interactivity:** `figure`, `table`, `img`, `svg`, `canvas`, `video`,
  `pre`, `section`, `article`, `dialog`, `iframe`, `role=region|figure|img|tabpanel`, plus
  card-like `div`s (border-radius / box-shadow / border within a size band). Names resolve
  `figcaption` → `caption` → contained heading → `aria-label` → `alt` → leading text.

Nested regions are deduped (a wrapper whose area is < ~1.3x its child loses to the semantic
child), capped at 60, in document order. Surfaced as `ReadPage(mode: "regions")`:

```
[r0] <header>  "Site nav"          1200x64
[r1] <figure>  "Q3 revenue chart"   640x420   (below fold)
[r2] <table>   "Pricing tiers"      820x310
```

**The `r` prefix is load-bearing.** The action registry uses bare `[3]`. If both registries used
bare integers the model would confuse a clickable index with a shootable one, and
`ControlPage({click, index: 1})` against a `<figure>` fails opaquely. Distinct sigils make that
bug unrepresentable.

The **semantic-snap heuristic** (deepest element >= 40px, promoted to a semantic ancestor sitting
close above it) already exists as `componentAt` in `capture.ts` and defines what a "component" is
for the human region-picker. It is lifted into a shared, tested predicate so the agent and the
human picker share one definition of "component" rather than diverging.

### 2. Capture engine (`screenshot.ts`)

Built on `captureVisibleTab` + canvas crop, reusing `capture.ts`'s `cropShot` math (which already
handles CSS-px → device-px → DPR correctly).

- **`viewport`** — hide the presence overlay, capture, downscale to 1400px.
- **`element`** — resolve the target (`region` index, or `selector` via a self-contained injection
  that stamps `data-agent-region` on the match), scroll into view, settle, **re-read the live
  rect**, capture, crop. Taller than the viewport → stitch, bounded to the element's box.
- **`fullpage`** — scroll-and-stitch:
  1. Inject prep: return `{scrollHeight, clientHeight, dpr, scrollY}`, force `scroll-behavior:auto`
     (smooth scrolling races the capture), remember scroll position.
  2. Capture slice 0 **with sticky/fixed elements visible** — the real header, once.
  3. Slices 1..N: **hide `position:fixed` and `position:sticky`**, scroll, settle (~350ms for lazy
     images), capture. Without this the header duplicates into every slice.
  4. Throttle ~550ms between captures — Chrome rate-limits `captureVisibleTab` to ~2/sec and
     silently rejects past that.
  5. Final slice is captured at `min(i*h, scrollHeight - clientHeight)`, so it overlaps the
     previous one; the overlap is cropped at draw time.
  6. Restore fixed elements, `scrollY`, and `scroll-behavior` **in a `finally`** — a page left
     scrolled to the bottom with its header hidden is a visible user-facing bug.

Total height capped at ~20000 CSS px; past that it truncates and **says so** in the tool result
rather than silently returning a partial page.

Decision-making is **pure**, Chrome calls are a thin shell around it:

```ts
planStitch(scrollHeight, clientHeight, maxHeight) -> { slices: [{scrollTo, srcY, srcH}], truncated }
planTiles(totalHeight, tileHeight, maxTiles)      -> { tiles: [{y, h}], dropped }
```

Both are pure functions over numbers — unit-testable with no Chrome. The off-by-one in the
overlap crop is where this feature would otherwise quietly rot.

### 3. Delivery to the model (`agent.ts`)

`imageQueue: string[]` becomes `imageQueue: QueuedImage[]`, `QueuedImage = { dataUrl, caption }`.

`prepareStep` currently hardcodes *"Set-of-marks screenshot… the numbered boxes correspond to the
[index] values"* onto every drained image — a lie the moment anything but `lookResult` pushes to
that queue. A model told "numbered boxes correspond to indices" while looking at an unmarked crop
of a bar chart will hallucinate indices onto it. So the caption travels with the image:

- `lookResult` keeps its exact current caption — **behavior preserved, no regression.**
- `Screenshot` supplies its own: `Screenshot of <figure> "Q3 revenue chart" on example.com —
  tile 2 of 4 (top to bottom).`

Tiles are pushed as N sequential entries, each captioned with its position, so the model reasons
about order rather than guessing.

**Budgets** (images are the most expensive thing this agent does): `MAX_TILES_PER_CALL = 6`, and a
per-turn counter capping total agent-pushed images at 12. On exhaustion the tool returns a note —
*"image budget for this turn is spent; the shot was saved for the user but not sent to me"* —
instead of failing. The model finishes the task; it just stops looking.

### 4. Storage & UI

New `agent-chat-screenshots` IndexedDB database with its own schema version, following the
one-DB-per-store pattern `conversations.ts` explicitly calls for.

- **Store:** `{ id, blob (full-res PNG), width, height, url, title, createdAt, conversationId }`.
- **Transcript holds only** `{ shotId, thumb, width, height }` — an ~8KB inline thumbnail. Loading
  a conversation never drags megabytes of PNG through the message record.
- **Pruning:** oldest-first, on a size ceiling (~50MB) and age ceiling (~30d), on store open.
- **Tool card** (`Chat.tsx`): label `Took a screenshot of …`, thumbnail inline, click opens the
  existing `ImageCarousel`, Download hydrates full-res via `download.ts`.

The full-res strip lives in storage; the model only ever sees tiles. Different artifacts, different
consumers — conflating them is what makes the naive version bad at both jobs.

### 5. Gating & failure

- **Approval:** standard `requestApproval` card with "Allow this chat" (read-only, never
  point-of-no-return) — **except** when a page-control session already owns this tab, mirroring the
  exemption `ReadPage(mode:"elements")` already has. The session grant covers looking at the page it
  is already driving; a card per verification shot would be unusable.
- **Vision:** `createAgentTools` takes `visionCapable: boolean`, resolved in `runTurnChain` before
  tool construction (the probe is cached per provider+model, so it is free after the first call).
  When false, `delete tools.Screenshot` — same mechanism as a `never` policy, so the tool is absent
  from the catalog and `ToolSearch`/`GetTool` cannot resurrect it.
- **Progressive disclosure:** `Screenshot` is not in the always-on core; it is discovered via
  `ToolSearch`, and joins the page-control cluster `RequestPageControl` self-expands on grant, so
  the verify-my-own-actions loop needs no extra round-trip.
- **Failure modes, each a readable error rather than a throw:** restricted pages (`chrome://`, Web
  Store) cannot be scripted; the tab stopped being active (`captureVisibleTab` only sees the focused
  tab); the region/selector matched nothing; the element has zero area. **Cross-origin iframes are
  invisible** to the top-frame injection — a chart inside one is not a region, and the tool says so
  instead of shooting the surrounding blank box.

## Verification

Vitest on the pure seams: `planStitch` / `planTiles` (slice offsets, overlap cropping, truncation,
tile-drop) and `rankRegions` / `serializeRegions` (nested dedupe, cap, `[rN]` formatting). The
injected page-world functions and Chrome calls are not unit-testable and should not pretend to be —
those get `npm run build` + `/verify-extension`, driving a real page with a chart below the fold, a
tall page with a sticky header, and an open control session.

## Rejected alternatives

- **`chrome.debugger` full-page capture** — one-call true full-page, but a permanent "Extension is
  debugging this browser" infobar on every page.
- **CSS-selector-only targeting** — no new index, but forces a 40k-char `ReadPage(mode:"dom")` first
  and hallucinated/brittle selectors fail silently on SPA class hashes. Kept as an escape hatch, not
  the primary address space.
- **Extending the existing `[index]` registry with visual elements** — one registry for acting and
  seeing, but it pollutes the page-control action list (the model cannot click a `<figure>`) and the
  200-element cap is already tight on real pages.
- **Stitching to a single downscaled image** — cheap in tokens, but a long page downscaled to the
  1400px cap becomes an illegible smear, defeating "see what text can't say" on exactly the pages
  where it matters.
