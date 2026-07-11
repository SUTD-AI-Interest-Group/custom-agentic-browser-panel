# Presence polish + ambient frame + cross-origin grace — design

Date: 2026-07-11

## Summary

Six related changes to the on-page "agent presence" system (`src/platform/presence.ts`)
and the page-control loop (`src/tools/pageControl.ts`, the `ControlPage` block in
`src/tools/tools.ts`, and the turn `finally` in `src/ui/Chat.tsx`):

1. The click ripple (`pulse`) fires after *every* successful action; gate it to `click`.
2. role=link / JS-driven cross-origin navigation is only caught by the next-call origin
   drift kill, never at/near the action; handle origin changes in the same step.
3. An approved cross-site navigation still tears the session down on the next call,
   forcing a second grant (double-prompt); re-fence the session instead.
4. Add an Apple-Intelligence-style soft light-blue breathing frame around the viewport,
   and soften the existing dark tint.
5. Double the agent cursor size (18px → 36px).
6. Make the presence overlay *ambient*: show the breathing frame whenever the agent
   autonomously touches a tab (NavigateTab, InspectPage), not only inside a granted
   page-control session.

None of 1–3 affect correctness today; they are friction/polish. 4–6 are UX additions.

## Current architecture (baseline)

- `presence.ts` injects a persistent, `pointer-events:none` overlay (`ROOT_ID`) into the
  page DOM via `chrome.scripting.executeScript`. It holds a full-page dark **tint**, a
  box-shadow **spotlight** hole over the focused element, and a gliding **cursor**.
  `pulse()` adds a one-shot click ripple at the cursor.
- The overlay is **session-only**: `mountPresence` is called once inside
  `RequestPageControl` (`tools.ts`) and torn down by `teardownSession`/`endSession` in
  `Chat.tsx`, which the turn's `finally` (line ~777) also calls.
- `runControlStep` (`pageControl.ts`) runs one action: `beforeAct` glide → real action →
  `afterAct` pulse → re-snapshot. It currently fires `afterAct` after any successful
  action and discards everything from the post-action snapshot except `.text`.
- `ControlPage` (`tools.ts`) checks `isPointOfNoReturn` (form submits, cross-origin nav,
  sensitive fields, Enter) and shows a one-shot approval card. At the **start** of each
  call it also compares `liveOrigin` to `session.origin` and, on mismatch, ends the
  session with an error ("call RequestPageControl again"). This is the "drift kill".
- `isPointOfNoReturn` only catches cross-origin *clicks* via `el.href`, which `domIndex`
  populates **only for real `<a>` tags** — so `<div role="link">` and JS `onclick`
  navigations have no href and slip past.
- `PageSnapshot` (`domIndex.ts`) already carries `url` and `origin`.

## Design

### 1. Pulse only on clicks

In `runControlStep`, gate the ripple:
`if (afterAct && result.ok && spec.action === 'click') await afterAct()`.
The cursor glide (`beforeAct`) is unchanged — it still moves to every targeted element.

### 2 + 3. Same-step origin handling (re-fence on approval, one-shot continue otherwise)

Two detection points cooperate: a **same-step** re-fence for crossings the post-action
snapshot can see reliably (fast path), and a **next-call** drift check for full-page loads
that commit only after that snapshot (robust backstop). A one-shot `crossingAuthorized`
flag on the session carries "the user already approved this crossing" across the gap.

- `runControlStep` surfaces the post-action origin: extend `ControlStepResult` with
  `origin: string` (from the post-action `snapshotPage`; empty string if the re-read
  failed). `ControlSession` gains `crossingAuthorized?: boolean`.
- In `ControlPage`, capture whether this step was an approved point-of-no-return
  (`const por = isPointOfNoReturn(...)`; if `por`, request approval and return DENIED on
  reject). After `runControlStep`, compare the returned `origin` to `session.origin`:
  - **changed** (snapshot saw it — explicit navigate settles 600ms; SPA/same-document nav
    is synchronous):
    - `por` → **re-fence** silently: `session.origin = newOrigin`; `crossingAuthorized =
      false`. Next call proceeds directly.
    - not `por` → one-shot card "Keep controlling the page now that it moved to
      `<host>`?". Approve → re-fence. Deny → `endSession` + notice.
  - **unchanged / empty** (a full-page load may still be committing) → stash the
    authorization for the next call: `session.crossingAuthorized = por`.
- The **start-of-call drift check** (was a hard session-kill) becomes graceful and uses
  the flag. When `liveOrigin !== session.origin`:
  - `crossingAuthorized` → re-fence silently (no second grant — this is what kills the
    double-prompt for a cross-origin href *click*, whose full-page load raced the
    post-action snapshot).
  - else → one-shot "keep controlling…?" card; deny → `endSession` + notice.
  - In both surviving cases it then **hands back the freshly-snapshotted page without
    running this call's action** (`session.origin` just changed, so the model's chosen
    `spec.index` is stale) — the model re-reads and re-issues. Clears
    `crossingAuthorized`.

Net: explicit cross-origin navigate and SPA/role=link JS nav are caught in-step; a
cross-origin href click's full-page load is caught on the next call and re-fenced without a
second grant; a genuinely unexpected self-navigation gets exactly one continue card. No
path silently acts on a stale index, and no path double-prompts for an already-approved
crossing.

### 4. Breathing light-blue frame + softened tint

In `presence.ts`:

- `injMount` adds a `.frame` child of the root: `position:fixed;inset:0;pointer-events:none`,
  inset light-blue glow via
  `box-shadow: inset 0 0 0 2px rgba(122,184,255,.5), inset 0 0 46px rgba(122,184,255,.35)`.
  Start a persistent breathe with the Web Animations API — self-contained, no injected
  `<style>`/keyframes, compositor-friendly opacity:
  `frame.animate([{opacity:.35},{opacity:.9},{opacity:.35}], {duration:2600, iterations:Infinity, easing:'ease-in-out'})`.
  It runs the whole time the overlay is mounted, hides with the root during screenshots
  (`setPresenceHidden`), and is removed on unmount.
- Soften `TINT` from `rgba(20,22,30,0.22)` → `rgba(18,22,34,0.13)` (slight blue cast).
  Spotlight still reads (rest of page = tint + spot-shadow vs. single-tint hole); page is
  lighter; the frame glow isn't fighting a dark wash.

### 5. Double cursor size

Cursor `18px → 36px`: div `width/height` → 36; `<svg>` `width/height` → 36 while keeping
`viewBox="0 0 18 18"` so the arrow path (and stroke) scale up cleanly. Positioning logic
(`translate(cx,cy)` from `injFocus`) is unchanged.

### 6. Ambient presence (frame for NavigateTab + InspectPage)

Split "present" from "actively controlling":

- **Presence registry.** `presence.ts` gains a module-level `mounted: Set<number>`.
  `mountPresence` records the tab; new `unmountAllPresence()` unmounts every tracked tab
  (turn-end cleanup). `unmountPresence(tabId)` also removes from the set.
- **Tint split.** `mountPresence(tabId)` shows the **frame-only** ambient glow — the tint
  div is created transparent, page not dimmed. A new `setTint(tabId, on)` toggles the
  soft dark tint. `RequestPageControl` calls `setTint(true)` after mounting to enter
  full-control mode. The spotlight's own box-shadow tint is baked at mount from the
  softened `TINT` and only ever appears in-session (spot is `display:none` until
  `focusOn`), so `setTint` need not touch it.
  - **Ambient** (NavigateTab / InspectPage) = breathing frame only.
  - **Element control** (ControlPage session) = soft tint + spotlight + cursor +
    click-pulse + frame.
- **NavigateTab** mounts the ambient frame on the returned `tabId` after a successful
  activate/goto/open (immediate for activate; a ~600ms settle for goto/open — matching the
  existing post-navigate delay in `runControlStep` — so the inject lands on the new
  document, not the unloading one). The mount is **awaited** inside `execute` (adding the
  settle to the tool's latency, which is acceptable for a navigation tool) rather than
  fire-and-forget: a delayed inject that escaped `execute` could land *after* the turn's
  `finally` ran `unmountAllPresence()` and leave a frame stuck on the page. Restricted URLs
  (`chrome://`) fail the inject silently via the existing `run().catch(() => {})` — no
  overlay, no error.
- **InspectPage** mounts the ambient frame while it reads. Idempotent (`injMount`
  early-returns when the root exists), so it never disturbs an already-mounted session
  tint.
- **Teardown.** The turn's `finally` in `Chat.tsx` calls `unmountAllPresence()` beside
  `pageControl.endSession()`, cleaning up ambient frames on every touched tab and
  honoring the existing "always tear down in `finally`" invariant. `teardownSession`
  keeps doing `clearIndex` on the session tab.

## Files touched

- `src/platform/presence.ts` — frame, breathe, softened tint, bigger cursor, `mounted`
  registry, `setTint`, `unmountAllPresence`.
- `src/tools/pageControl.ts` — click-only pulse; `origin` on `ControlStepResult`;
  `crossingAuthorized?` on `ControlSession`.
- `src/tools/tools.ts` — graceful start-of-call drift check + same-step origin re-fence /
  continue card in `ControlPage`; `setTint(true)` in `RequestPageControl`; ambient mount in
  `NavigateTab` + `InspectPage`; `hostLabel` helper.
- `src/ui/Chat.tsx` — `unmountAllPresence()` in the turn `finally`.

No interface churn beyond adding `origin` to `ControlStepResult` and two new exports in
`presence.ts` (`setTint`, `unmountAllPresence`).

## Invariants preserved

- Every agent tool still routes through `requestApproval` (the continue card is another
  one-shot gate; ambient mounts are cosmetic and gate nothing new).
- Page control's two nested gates are unchanged; the re-fence only updates the fence
  origin *after* the user has approved the crossing.
- Presence overlay is still always torn down in the turn's `finally` — now for every
  touched tab, not just the session tab.
- Injected functions stay fully self-contained (no closures/imports); all new state is
  passed as `args` or lives in the side-panel module, never in the page injection.

## Verification

No test suite. `npm run build`, reload the unpacked extension in `chrome://extensions`,
then exercise via the `/verify-extension` skill:
- NavigateTab / InspectPage → breathing frame appears, no page dimming, torn down at turn
  end.
- RequestPageControl → soft tint + spotlight + bigger cursor + breathing frame; pulse
  only on click actions.
- Approved cross-site navigate → session continues (no second grant card).
- A role=link/JS cross-origin click → one-shot "page moved — continue?" card.
