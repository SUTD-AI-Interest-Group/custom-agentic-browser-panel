# Design: `GetScreenshot` + `GetElementScreenshot`

**Date:** 2026-07-20
**Status:** Approved (design)
**Branch:** `worktree-screenshot-tools`

## Problem

A user asked the agent (running a Qwen model) to "take a screenshot of the models
available" on a web page. The model searched its tools, found no screenshot
capability, and concluded from `ReadPage`'s description ("pass its number to
Screenshot") that a Screenshot tool *should* exist but was missing. It ended up
describing the page from text instead of producing an image.

The user's stated ask: implement a `GetScreenshot()` tool that captures the exact
rendered browser viewport, and a `GetElementScreenshot()` tool for element-region
crops — "for the model to process or return to the user as a multimodal output."

### What is actually true

The premise that the current tool is "DOM-based" does not hold. A real
browser-viewport capture engine already exists:

- `src/platform/screenshot.ts`'s `capture()` shoots via
  `chrome.tabs.captureVisibleTab` — the **real composited browser viewport**
  (GPU-rendered pixels: CSS, images, canvas, video frames), not a DOM re-render.
- It already supports all three targets: `viewport`, `element` (via `[rN]` region
  or CSS selector), and `fullpage` (scroll-and-stitch).
- Every shot is already persisted as a user-facing artifact (`saveShot`) and
  rendered inline in chat via `ShotCard` (`src/ui/Chat.tsx`), read from IndexedDB —
  so "return to the user as a multimodal output" already works for any model.

The reason the Qwen agent could not find it is a single line in
`src/tools/tools.ts`:

```ts
if (!visionCapable) delete tools.Screenshot
```

The runtime vision probe (`src/agent/vision.ts`) marked the user's model text-only
(or the probe timed out / the endpoint dropped the image part), so `Screenshot`
was deleted from the ToolSet entirely and never appeared in `ToolSearch`.

So the real gap is **not** a missing capture engine — it is that a text-only model
cannot produce a screenshot *even to hand back to the user as an artifact*.

## Decision

Chosen direction (user-approved): **replace** the single `Screenshot` tool with two
dedicated, clearly-named tools built on the existing `capture()` engine, and make
them available to **all** models — including text-only ones.

## Tool surface

### `GetScreenshot`

Captures the live rendered browser viewport of the active tab. This is the visible
web-content viewport of the active tab (the composited page pixels) — not the OS
screen and not the browser toolbar/chrome.

- `fullPage?: boolean` — default `false` (visible viewport, `capture` `kind:'viewport'`).
  When `true`, scroll-and-stitch the whole page (`kind:'fullpage'`).
- `reason: string` — shown on the approval card.

### `GetElementScreenshot`

Crops one element region to a PNG (`capture` `kind:'element'`).

- `region?: number` — an `[rN]` index from `ReadPage(mode:"regions")` (preferred).
- `selector?: string` — CSS-selector escape hatch.
- `reason: string` — shown on the approval card.
- Requires at least one of `region` / `selector` (the engine already enforces and
  errors clearly when neither is given).

Both tools are thin wrappers over `capture()` — no capture/stitch/tiling logic is
reinvented. Both route through `requestApproval` (unchanged security model), with
the same page-control-session exemption the current `Screenshot` tool has.

## Behavioral change: available even to text-only models

This reverses one architecture invariant (documented in `CLAUDE.md`: "Screenshot is
deleted from the ToolSet when the vision probe says the model is text-only"). The
old rationale — "a tool whose whole product is an image is worse than absent for a
blind model; it will call it, get nothing, and retry" — no longer holds once the
image's *primary* product is the user-facing artifact, not the model-facing one.

New behavior:

- **The tools are always present** (no delete gate). They always run and always
  `saveShot`, so the human sees the result inline via `ShotCard`.
- **Vision-capable model:** unchanged — tiles are pushed onto `imageQueue`, the
  per-turn image budget (`MAX_SHOT_IMAGES_PER_TURN`) is respected, and the model
  sees the picture on the next step.
- **Text-only model:** the shot is saved for the user, but *no image is queued*.
  The tool returns a note that stops the retry loop, e.g.:
  > "Saved a screenshot of `<label>` on `<host>` — it is shown to the user in the
  > chat. You can't view images, so it was not sent to you; work from the page text
  > if you need the contents."

  `visionCapable` thus changes from a *delete switch* into a *routing flag*
  (feed-the-model vs. note-and-save).

## Touch list

- **`src/tools/tools.ts`**
  - Replace the `Screenshot` tool definition with `GetScreenshot` + `GetElementScreenshot`.
  - Remove `if (!visionCapable) delete tools.Screenshot`; instead branch inside the
    tools on `visionCapable` (queue tiles vs. note-and-save).
  - `RequestPageControl` control cluster: `activeNames.add('Screenshot')` →
    `activeNames.add('GetScreenshot')` (viewport self-check after a `ControlPage`
    action). Text-only is harmless (note-and-save, no loop).
  - `ReadPage(mode:"regions")` description + its `note`: "pass its number to
    Screenshot" → "pass its number to GetElementScreenshot".
- **`src/ui/Chat.tsx`**
  - `ShotCard` render condition (`part.toolName === 'Screenshot'`, ~lines 2412/2428)
    → match `GetScreenshot` **and** `GetElementScreenshot`.
  - `activeNames` seeding that references `'Screenshot'` (~line 1214) and the
    adjacent vision comment (~1217) → new names.
- **`README.md`** — update the feature tour / tool list naming.
- **`CLAUDE.md`** — update the "Screenshot is deleted when text-only" invariant to
  the new "always present; routed by vision capability" behavior, and the
  Screenshot naming in the perception-registry and screenshot invariants.
- **Tests** — `src/platform/screenshot.test.ts` (pure planners) is unaffected. Add
  coverage for the new routing where it is pure/checkable; adjust any test that
  asserts the old delete-gate. (`agent.test.ts` locks the disclosure/repair
  behavior — verify the new tool names still self-heal through `repairToolCall`.)

## Out of scope

- No change to the capture/stitch/tile engine, the artifact store, or `ShotCard`
  beyond the tool-name match.
- No change to the vision probe itself. (If the user's Qwen model is in fact
  vision-capable and mis-probed, that is a separate investigation; this design makes
  screenshots work regardless of the probe outcome.)
- No new full-page-only tool; full page is a `fullPage:true` flag on `GetScreenshot`.

## Verification

The capture math is already pure-tested. After implementation, in the worktree:

1. `npm run typecheck` and `npm run build` (tsc gate first).
2. Reload the unpacked extension in `chrome://extensions`.
3. Exercise: (a) viewport shot, (b) element shot via `[rN]`, (c) `fullPage:true`,
   (d) a **text-only** model path — confirm the artifact renders in chat for the
   user and the model does not loop.
