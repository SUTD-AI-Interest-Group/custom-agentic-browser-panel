# NavigateTab intent animation

## Problem

The `NavigateTab` tool (`src/tools/tools.ts`) navigates the user's tabs after an
approval card, but the navigation itself is autonomous and silent: the page just
swaps. Unlike the page-control (browser-use) flow — which glides an agent cursor
and pulses over the element it acts on via the presence overlay — `NavigateTab`
gives the user no on-page cue that the agent is about to move them somewhere.

We want the same agent-presence visual language applied to navigation: before the
page swaps, show a cursor with a popover ("Navigating to `<host>`…"), pause, then
progressively darken the page (a fade-out), and only then perform the real load.

## Scope

- **`goto` only.** `goto` loads a URL into an existing tab that still has content
  to dim in the window before `chrome.tabs.update` swaps the document. `open`
  creates a fresh blank tab (nothing on screen to darken) and `activate` loads no
  URL (a "Navigating to…" popover would be misleading), so both are excluded.
- **Best-effort, never blocks.** The animation must never prevent or delay-fail a
  navigation. Restricted pages (`chrome://`, the Web Store) reject script
  injection; that just skips the cue and navigates immediately.
- **NavigateTab tool only.** The page-control `navigate` action
  (`src/tools/pageControl.ts`) already runs inside a presence session and is out
  of scope.

## Design

### Overview

Play the cue on the target tab's *current* page, in the window between approval
and the real `chrome.tabs.update`. Then navigate. Because the load replaces the
document, the injected overlay is wiped automatically — the existing post-nav
`mountPresence(result.tabId)` re-establishes the ambient frame on the fresh page,
so there is nothing to tear down.

The whole cue reuses the presence overlay (`src/platform/presence.ts`): its
`ROOT_ID` root, `.tint` element, and cursor SVG. It adds a navigation-flavored
popover and a lively blue shimmer, in the same accent blue (`rgba(122,184,255)`)
as the breathing frame and cursor.

### Sequence (added latency ≈ 1.2s)

1. **Ensure overlay.** Call the existing `mountPresence(tabId)` (no-ops if already
   mounted on this tab).
2. **Cue.** Glide the cursor to viewport center and show a blue pill popover above
   it: `Navigating to github.com…`. Host is parsed from the URL; falls back to the
   raw URL string if `URL()` throws.
3. **Hold ~650ms** so the user reads the popover. *Then* —
4. **Darken + shimmer.** Ramp the `.tint` background from transparent to a heavy
   dark wash (`rgba(8,10,18,0.55)`) over ~550ms, and fade in a `.navshimmer`
   layer (two drifting/pulsing blue radial blobs) over the same window.
5. **Hold ~550ms** for the ramp to finish, then resolve.
6. Tool proceeds to the real `navigateTab(...)`.

The pause-then-darken ordering is enforced from TypeScript (two injected calls
with an awaited sleep between them), not from page-side timers — so the ordering
is explicit and robust to the stateless-injection model.

### Blue shimmer

`.navshimmer` sits above `.tint`, below the cursor/popover, `pointer-events:none`.
It fades in together with the darken ramp so the shimmer "arrives" as the page
dims — the dark wash reads as living blue light, not flat black. It contains two
soft blue radial-gradient blobs animated via the Web Animations API (`.animate()`)
— the same self-contained technique the breathing frame already uses: **transform
+ opacity only** (compositor-friendly), **no injected `<style>`/keyframes**. Each
blob drifts on its own translate loop and pulses opacity, at slightly different
durations so they never sync into an obvious beat.

### Code changes

**`src/platform/presence.ts`** — add one exported helper plus two self-contained
injected functions:

- `injNavCue(rootId, label)` — center the cursor; create/update a `.navlabel`
  popover pill (blue like the existing `.label`) positioned above the cursor with
  the given text.
- `injNavDarken(rootId, tint, ms)` — set the `.tint` element's transition to
  `background ${ms}ms ease` and background to `tint`; create the `.navshimmer`
  layer with its two blobs and start their WAAPI drift/pulse loops; fade the layer
  in over `ms`.
- `animateNavIntent(tabId, label)` — orchestrates: `await mountPresence(tabId)`
  → `run(injNavCue)` → `sleep(HOLD_MS)` → `run(injNavDarken)` → `sleep(DARKEN_MS)`.
  All injection rides the existing `run()` wrapper (already `.catch(() => {})`),
  so failures are swallowed and the caller always continues.

Constants: `HOLD_MS = 650`, `DARKEN_MS = 550`, `NAV_TINT = 'rgba(8,10,18,0.55)'`.

**`src/tools/tools.ts`** (`NavigateTab.execute`) — after `approved`, before
calling `navigateTab(...)`, when `action === 'goto'`:

- Resolve the target tab up front: `const targetId = tabId ?? (await getActiveTab())?.id`
  (needed because the current page must be animated *before* the load, and `goto`
  may omit `tabId`, defaulting to the active tab).
- Derive the host label from `url` (see below), then
  `await animateNavIntent(targetId, label)`.
- Guard: only when `targetId !== undefined` and a `url` is present.

The rest of `execute` is unchanged: `navigateTab(action, { tabId, url })`, then the
existing post-nav `mountPresence(result.tabId)`.

### Host parsing

Inlined in `tools.ts` at the call site: `try { new URL(url).host } catch { return url }`
— derive the label, pass the string into `animateNavIntent`. It is a trivial
one-liner, so no separate exported helper and no unit test; `presence.ts` receives
only the finished display string and stays URL-agnostic.

## Testing

Most of this is Chrome/DOM-coupled (`chrome.scripting.executeScript`, injected DOM)
and not unit-testable, consistent with the rest of `presence.ts` (which has no
tests). Verification is manual via the `/verify-extension` flow:

1. `npm run build`, reload the unpacked extension.
2. Ask the agent to navigate the current tab to a site (`goto`); approve.
3. Confirm: cursor + "Navigating to `<host>`…" popover appears, holds, then the
   page darkens with drifting blue shimmer, then the new page loads with the
   ambient frame present.
4. Confirm `open` (new tab) and `activate` (switch) show **no** darken cue.
5. Confirm navigating a `chrome://` tab still works (no cue, no error).

No new automated tests: the injected DOM/animation is Chrome-coupled and the host
parse is a trivial inline one-liner. The existing suite must still pass unchanged.

## Non-goals

- No arrival cue on the destination page beyond the existing ambient frame.
- No animation for `open` / `activate`.
- No change to the page-control `navigate` path.
- No configurability (timings/colors are constants, matching presence.ts style).
