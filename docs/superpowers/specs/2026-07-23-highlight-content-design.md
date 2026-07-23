# HighlightContent — on-page visual grounding for Q&A

**Date:** 2026-07-23
**Status:** Approved

## Problem

When the user asks about the page they're reading — "what are the terms stated in
this document?", "which part of the article mentions the author's childhood?" —
the agent answers in chat but the user still has to find the passage themselves.
The agent should ground its answer *on the page*: scroll to the passage or
component it is citing and highlight it like a marker pen, so the user's eyes
land where the answer came from.

The existing `ControlPage` `highlight` action is the wrong fit: it requires a
full page-control session grant, only addresses interactive `[index]` elements
(not prose or figures), rides the presence overlay that is torn down at turn
end, and does nothing for PDFs.

## Tool surface

One new gated tool in `createAgentTools()`: **`HighlightContent`**.

- **Params:** exactly one of
  - `text` — the exact passage to find (whitespace-normalized, case-insensitive
    match), or
  - `region` — an `[rN]` number from `ReadPage(mode:"regions")`, for
    charts/figures/tables/images;

  plus optional `label` (short callout, e.g. "Termination clause") and optional
  `page` (PDF page hint that skips the cross-page search).
- **Gate:** routes through `requestApproval` like every tool, with the same
  exemption the perception tools get while an open page-control session owns the
  tab. Low-risk framing: draws on the page and scrolls; never clicks, types, or
  submits.
- **Additive within a turn:** each call adds a highlight; a multi-clause answer
  may highlight several passages that all stay visible together.
- **Proactive use:** the tool description tells the model to use it whenever its
  answer is grounded in a specific passage the user could be looking at, and
  `ReadPage`/`ReadPdf` results carry a one-line tip pointing at it (the same
  nudge pattern `mode:"regions"` uses for `GetElementScreenshot`).

## Webpage path — `src/platform/highlight.ts`

New platform module following `presence.ts` conventions: fully self-contained
injected functions, everything passed as args, re-finds state by DOM id.

- **Text passages use the CSS Custom Highlight API** (`CSS.highlights` plus an
  injected `::highlight(...)` style rule): a `Range` over the matched text gets
  a marker-yellow background that tracks reflow/resize natively — no overlay
  boxes drifting out of alignment. Cleanup is `CSS.highlights.delete()` plus
  removing the injected style. Chrome ≥105, which MV3 already assumes.
- **Finding the passage** is a pure matcher in `src/platform/highlightText.ts`
  (Chrome-free, unit-tested, mirroring the `pdfText.ts` split): normalize
  whitespace on needle and haystack, find the needle case-insensitively, and map
  the normalized match back to (text-node index, character offset) pairs. The
  injection walks `document.body` text nodes with a TreeWalker, feeds their
  strings to the matcher, and builds the `Range` from the mapped offsets. First
  match is highlighted; the tool result reports the total match count.
- **Regions** get a document-space ring overlay instead (a background color on a
  chart is invisible): own root `__agent_highlight`, separate from
  `__agent_presence`, z-index just below it so the presence cursor stays on top.
  Targets are re-found via the `data-agent-region` stamp, and the live rect is
  re-read after scrolling (lazy-load/sticky reflow invalidate indexed rects).
- **`label`** renders as a small pill anchored to the highlight (both kinds).
- **Scroll:** `scrollIntoView({block:'center', behavior:'smooth'})` on the
  target, plus a brief glow pulse to catch the eye.

## PDF path

Chrome's PDF viewer is a sealed plugin — nothing can be painted inside it. The
tool dispatches on the same "active tab is a PDF" check `ReadPage` uses, then:

1. **Locate:** with a `page` hint, search that page's extracted text; otherwise
   reuse the `pdfText` search across pages and take the best match.
2. **Mark:** pdf.js `getTextContent()` items carry positions; map the matched
   items' boxes through the page viewport, render the page with the existing
   `mode:"view"` machinery, and draw translucent marker rects over the match.
3. **Deliver:** save the PNG as a shot artifact in IndexedDB → `ShotCard` in
   chat, captioned with the page number + label. The image is **user-only** —
   the model already knows the text, so nothing rides `imageQueue` and nothing
   image-shaped enters the tool result.
4. **Jump the viewer:** `chrome.tabs.update` to the same URL with `#page=N`,
   best-effort — Chrome honors the fragment on load; an already-open viewer may
   ignore a fragment-only change, and the in-chat render carries the answer
   regardless.

## Lifetime

- Module-level `highlightedTabs` set (like presence's `mounted`), but
  **deliberately not cleared in `runTurnChain`'s outer `finally`** — that
  asymmetry against the presence invariant is what lets highlights outlive the
  turn so the user can read what was marked. A code comment at the teardown site
  flags it as intentional.
- Highlights are cleared at the **start of the next turn chain** (a fresh
  question starts from a clean page). Page navigation wipes the injection
  naturally. Stop leaves highlights in place.
- Coexists with an active control session; presence renders above it.
- PDF leaves nothing to clear (chat artifact persists; `#page=N` is harmless).

## Errors & edges

- Restricted pages (chrome://, Web Store): injection fails → the tool returns a
  plain-sentence explanation, never crashes.
- Passage not found → the result tells the model to re-read the page and pass
  the *exact* on-page text (it may have paraphrased).
- Ambiguous match (needle appears many times) → first occurrence highlighted,
  count reported so the model can disambiguate with a longer quote.
- Cross-origin iframes: out of scope, matching `ReadPage`.

## Testing

- **Unit (Vitest):** the normalize-and-map matcher in `highlightText.ts`
  (multi-node spans, case folding, whitespace runs, not-found, offset mapping);
  the PDF match→rect mapping helper (pure part in `pdfText.ts` style).
- **E2E:** `/verify-extension` — build, reload, then on a real article ask a
  "which part mentions…" question and confirm scroll + marker + label; on a PDF
  confirm the viewer jumps and the highlighted render lands in chat.

## Invariants respected

- Gated through `requestApproval`; discoverable automatically via the derived
  tool catalog (no hand-maintained list).
- No image in a tool return value; the PDF render is a user artifact only.
- Injected functions are self-contained (no closures/imports), re-find elements
  via DOM stamps, and re-read live rects after scrolling.
- Pure logic (`highlightText.ts`, PDF rect mapping) stays Chrome-free and
  unit-tested.
