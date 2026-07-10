# Browser-Use / Page Control — Design Spec

**Date:** 2026-07-10
**Status:** Approved design, pre-implementation
**Feature:** An autonomous "browser-use" capability that lets the agent control the active tab — read the page, click, fill fields, select dropdowns, navigate, scroll, and highlight — presented to the user through an on-page "agent presence" overlay.

---

## 1. Overview

Today the agent can only *read* tabs (`ViewCurrentTab`, `ViewOpenedTabs`) and attach screenshots. This adds the ability to *act* on the active tab: an indexed-DOM perception layer, a small action loop, a scoped human-in-the-loop **session** grant, and a choreographed on-page presence overlay (tint + gliding cursor + "flashlight" spotlight) that shows the user what the agent is doing.

The design reuses three things the codebase already has:

- **Stateless function injection** via `chrome.scripting.executeScript` (same mechanism as `extractPageContent` / `selectRegionInPage`) — no persistent content script, no new permissions.
- **The approval/session gate** in `Chat.tsx` (`requestApproval`, `sessionAllowed`, `turnAllowed`, `stop()`) — the control session is a scoped, richer sibling of the existing "Allow this chat" concept, and Stop already both denies the pending card and aborts the turn.
- **The tint + un-tint overlay technique** from `capture.ts` (`selectRegionInPage`'s `box-shadow: 0 0 0 99999px <tint>` hole) — the presence overlay is that trick made persistent and animated.

## 2. Goals / Non-goals

**Goals**
- Full interactive control of the **active tab**: read, click, type, select, scroll, highlight, navigate.
- **Model-agnostic**: works with any OpenAI-compatible endpoint, vision or not.
- **Adaptive perception**: set-of-marks (numbered screenshot + text list) for vision-capable models; indexed-DOM text for the rest. Both render from **one element registry**; the action layer is identical either way.
- **Human-in-the-loop, but not tedious**: one upfront session grant with a stated plan; subsequent low-risk actions auto-run into a live activity log; only point-of-no-return actions re-prompt; Stop always available.
- **Visible agency**: an on-page overlay tints the page and moves an agent cursor to each component it works on, lighting that component up at the moment of interaction.
- **Zero new manifest permissions.**

**Non-goals (v1)**
- `chrome.debugger` / CDP trusted-event dispatch (deferred — see §12).
- Cross-tab / background orchestration (active tab only).
- Controlling `chrome://`, the Web Store, or other unscriptable pages (fails gracefully).
- Persisting a control session across conversations (sessions are per-task).

## 3. Research summary (why these choices)

Five reference approaches were surveyed (browser-use, Anthropic computer-use / Claude-in-Chrome, Playwright-MCP, WebVoyager set-of-marks, and extension agents Nanobrowser/TaxyAI). Conclusions that drove this design:

- **Perception:** indexed-DOM/accessibility text (browser-use, Nanobrowser, Playwright-MCP default) is the only approach that works with a non-vision model; screenshot-coordinate/set-of-marks approaches hard-require vision. → Use indexed DOM as the substrate; render *as* set-of-marks only when the model is vision-capable. Set-of-marks and indexed-DOM are two renderings of the same registry, not two systems.
- **Input dispatch:** synthetic DOM events need no new permission and no banner but fail on `isTrusted`-gated widgets and need the native-value-setter trick for React/Vue controlled inputs; `chrome.debugger`/CDP gives trusted events but requires the `debugger` permission and shows Chrome's persistent "started debugging this browser" banner. → Since every action already passes a human-in-the-loop card, synthetic events are the right default; CDP is a deferred escape hatch.
- **Stale references:** browser-use's main correctness lesson is that element indices drift after re-render; resolve indices against a fresh snapshot and fail explicitly on miss rather than acting on the wrong node.

## 4. Locked decisions

1. **Approval model:** session grant + live activity log + Stop; individual cards only for point-of-no-return actions.
2. **Scope:** full interactive control (read, click, fill, select, navigate, scroll, highlight).
3. **Perception:** one element registry → set-of-marks (marked screenshot + text list) for vision models, text-only otherwise.
4. **Vision check:** runtime probe once, cached per provider+model.
5. **Dispatch:** synthetic events + native-value-setter; `chrome.debugger` deferred.
6. **Presence overlay:** persistent tint + gliding agent cursor + flashlight spotlight, choreographed per action.
7. **Action budget:** 20 actions per session.

## 5. Architecture

```
RequestPageControl(plan) ── session card ("control github.com to: <plan>?") ──► opens ControlSession
        │ returns first snapshot                                                (bound to tab + origin)
        ▼
   ┌── InspectPage ─────────────► registry: text list (+ set-of-marks screenshot if vision)
   │      (read-only "look")             [3]<button "Sign in">  [7]<input email "Email">
   │
   └── ControlPage(action, idx, …) ─► focusAndAct: cursor glides to #idx, spotlight opens,
          auto within session,          then the real DOM interaction fires, then a click pulse.
          EXCEPT point-of-no-return      Returns fresh text registry.
          → individual approval card
```

The **element registry is the single source of truth.** `#7` resolves to the same DOM node regardless of how the model perceived it. The MV3 wrinkle (injections are stateless — no JS reference survives between `executeScript` calls) is solved by stamping `data-agent-idx="7"` onto each element during indexing (on the shared DOM, visible to later ISOLATED-world injections); action injections re-find `[data-agent-idx="7"]`.

## 6. File map

| File | New? | Responsibility |
|---|---|---|
| `src/platform/domIndex.ts` | new | Inject `buildInteractiveIndex()` (walk DOM → visible+interactive filter → stamp `data-agent-idx`, return `IndexedElement[]` + viewport rects) and `clearAgentIndex()` cleanup. Serialize the registry to compact text. |
| `src/platform/pageActions.ts` | new | Injected DOM executors: click, type (native-setter + `input`/`change`), select, scroll, press. `navigate` via `chrome.tabs.update`. These are the *real* mutations. |
| `src/platform/presence.ts` | new | Injected presence overlay: `mountPresenceOverlay(tint)`, `focusCursor(rect)`, `openSpotlight(rect)`, `pulse()`, `unmountPresenceOverlay()`. The *show*. `focusAndAct` composes presence + pageActions. |
| `src/platform/marks.ts` | new | Compose the set-of-marks screenshot: `captureVisibleTab` + draw numbered boxes on a canvas from the rects (reuses the `cropShot` canvas pattern). |
| `src/agent/vision.ts` | new | `ensureVisionCapability(provider, modelId)` — runtime probe + cache in `chrome.storage.local`. |
| `src/tools/pageControl.ts` | new | `ControlSession` type, point-of-no-return classifier, session gate helpers — keeps `tools.ts` lean. |
| `src/tools/tools.ts` | edit | Register `RequestPageControl`, `InspectPage`, `ControlPage`; wire the gates. |
| `src/agent/agent.ts` | edit | Bump `MAX_STEPS` (10 → 24). The action budget + Stop are the real bounds. |
| `src/ui/Chat.tsx` | edit | `pageSession` ref + session-card variant (renders the plan); presence-overlay teardown in the turn `finally`; richer `ToolPill` labels for control actions. |
| `src/ui/styles.css` | edit | Session-card and action-pill styles. (Overlay styles are injected inline into the page, not from here.) |
| `public/manifest.json` | **no change** | `scripting`, `tabs`, `activeTab`, `<all_urls>` already cover everything. Zero new permissions. |
| `README.md` / `CLAUDE.md` | edit | Document the capability; update the "Extending" / architecture sections. |

## 7. Tool surface

Three tools added to `createAgentTools()`. All page-mutating behavior is centralized in one `ControlPage` enum tool (rather than discrete per-action tools) so the session gate lives in one place and the model sees a compact browser-use-style action space.

```ts
RequestPageControl({ plan: string })
// The ONE upfront gate. Shows the session card with the model's stated plan.
// On allow → opens a ControlSession bound to the active tab id + origin, mounts
// the presence overlay, indexes the page, and RETURNS the first snapshot (so it
// doubles as the first InspectPage). On deny → { denied: true }.

InspectPage({ reason?: string })
// Read-only perception. Re-indexes and returns the registry as text; for a
// vision-probed model, ALSO returns the set-of-marks screenshot via the AI SDK
// tool-result image channel (toModelOutput → media part). Free inside an open
// session; standalone (no session) it asks for approval like ViewCurrentTab.

ControlPage({
  action: 'click' | 'type' | 'select' | 'scroll' | 'highlight' | 'navigate' | 'press',
  index?: number,       // target element from the registry (click/type/select/scroll-to/highlight)
  text?: string,        // for 'type'
  value?: string,       // for 'select'
  url?: string,         // for 'navigate'
  keys?: string,        // for 'press' (Enter | Tab | Escape)
  direction?: 'up' | 'down' | 'toElement',  // for 'scroll'
  label?: string,       // for 'highlight' — callout text shown on the page
  sensitive?: boolean,  // model self-flags a risky action → forces a card
})
// One action. Requires an open session. Runs focusAndAct (presence choreography
// + real interaction). Auto within session for low-risk actions; point-of-no-return
// → individual approval card. Returns { ok, message, registry, urlChanged? }.
```

`highlight` and `scroll(direction: 'toElement')` are the read-only "show-me" actions: the agent scrolls the real tab to element `#index` and opens a fading, labelled spotlight. Always auto-allowed.

## 8. Data model / types

```ts
// src/platform/domIndex.ts
interface IndexedElement {
  index: number
  tag: string                    // 'button', 'input', 'a', …
  role?: string                  // ARIA role or inferred
  name: string                   // accessible name: aria-label | text | placeholder | value (truncated)
  type?: string                  // input type
  value?: string                 // current value (for inputs/selects), truncated
  rect: { x: number; y: number; width: number; height: number }  // viewport CSS px
  sensitive: boolean             // password/payment heuristic (see §11)
}

interface PageSnapshot {
  url: string
  title: string
  origin: string
  dpr: number
  elements: IndexedElement[]
  text: string                   // compact serialization for the model, e.g. `[7]<input email "Email">`
  truncated: boolean
}

// src/tools/pageControl.ts
interface ControlSession {
  tabId: number
  origin: string                 // the origin the grant is scoped to
  plan: string
  actionsUsed: number
  maxActions: number             // 20
  active: boolean
}
```

## 9. Approval / session model

The control session is a scoped sibling of the existing `sessionAllowed` set, but richer (it carries a plan, an origin fence, and an action counter) and **per-task, not per-conversation** (no "Allow this chat" button on the session card).

Wiring (in `Chat.tsx`, mirroring how `requestApproval` is created and passed into `createAgentTools`):

```ts
interface PageControlGate {
  requestSession(input: { plan: string; host: string; tabId: number }): Promise<boolean>
  session(): ControlSession | null
  endSession(): void
}
```

- `createAgentTools(requestApproval, pageControlGate, tabAccess)` — the new gate is passed alongside the existing `requestApproval`.
- `RequestPageControl.execute()` → `pageControlGate.requestSession(...)` → shows the session card (**[Deny] [Allow]**, plan rendered) → on allow, opens the `ControlSession` (a React ref, like `sessionAllowed`), mounts the presence overlay, indexes, returns the first snapshot.
- `ControlPage.execute()` → checks `pageControlGate.session()`:
  - no session / inactive → error `"call RequestPageControl first"`.
  - action budget exhausted (`actionsUsed >= 20`) → close session, return `"action budget reached — ask the user to continue"`.
  - **point-of-no-return** (see §11) → `await requestApproval(...)` (individual card) even inside the session.
  - otherwise → auto-proceed; increment `actionsUsed`; stream a live `ToolPill`.
- **Stop**: existing `stop()` (denies the pending card + `abortRef.current.abort()`) ends the turn; the `finally` path tears down the overlay and ends the session.

The live activity log **is** the existing assistant-message `ToolPill` stream, with control-specific labels ("Typed into Email", "Clicked Sign in", "Scrolled to results", "Highlighted the price").

## 10. Perception & vision probe

**Indexing** (`buildInteractiveIndex`, injected, ISOLATED world):
- Candidate elements: tag allowlist (`A, BUTTON, INPUT, SELECT, TEXTAREA`), ARIA roles (`button, link, checkbox, radio, tab, menuitem, …`), `[contenteditable]`, `[onclick]`, and elements with `cursor: pointer` + event listeners (best-effort).
- Visibility filter: non-zero `getBoundingClientRect`, not `display:none` / `visibility:hidden` / `opacity:0`, within/near the viewport, and topmost at its center via `elementFromPoint` (to drop occluded elements). The presence overlay is `pointer-events:none` so it does not interfere with hit-testing.
- For each surviving element: assign sequential `index`, stamp `data-agent-idx`, collect `IndexedElement`. Serialize to compact text.

**Set-of-marks** (`marks.ts`, side-panel side): capture a **clean** `captureVisibleTab` PNG (presence overlay hidden for the shot — §13), then draw numbered boxes at `rect × dpr` on a canvas. Returned to a vision model as a tool-result image via the AI SDK's `toModelOutput` (media part).

**Vision probe** (`vision.ts`): cache key `visionProbe:{providerId}:{modelId}` in `chrome.storage.local`. On cache miss, render a small canvas (~240×80) containing a random 4-char code, send a one-shot completion with that image + "Reply with only the 4-character code in this image." If the reply contains the code → vision-capable (handles endpoints that silently ignore images by *not* echoing the code). Any error → treat as non-vision. Runs lazily on first session start; result cached thereafter.

## 11. Input dispatch & point-of-no-return

**Dispatch** (`pageActions.ts`, injected, ISOLATED world — the shared DOM makes the native-setter work without MAIN world):
- click → `element.scrollIntoView` + `element.click()` (plus `mousedown`/`mouseup` dispatch if needed).
- type → native value setter, then dispatch `input` + `change` (and `keydown`/`keyup` where sites listen):
  ```js
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, text); el.dispatchEvent(new Event('input',  { bubbles: true }))
                          el.dispatchEvent(new Event('change', { bubbles: true }))
  ```
  contenteditable → set `textContent` + `input` event.
- select → set `select.value` + `change`.
- scroll → `scrollIntoView({behavior:'smooth'})` (toElement) or `scrollBy` (up/down).
- press → dispatch `keydown`/`keyup` for Enter/Tab/Escape.
- navigate → `chrome.tabs.update(tabId, { url })` (side-panel context).

**Point-of-no-return classifier** (`pageControl.ts`) — always an individual card, even mid-session:
- Form submit: `action:'click'` on a submit-type button, or `action:'press', keys:'Enter'` inside a form.
- Navigation to a **different origin** (`navigate` to a new host, or a click that changes origin).
- Sensitive fields: `input[type=password]`, `autocomplete=cc-*`, or `name`/`id` matching `/card|cvv|ssn|password/i` (also sets `IndexedElement.sensitive`).
- Model self-flag: `sensitive: true`.

## 12. Presence overlay (the "show")

Persistent, `pointer-events:none`, top-z-index overlay injected at session open, torn down at close.

- **Tint layer:** ~`rgba(20,22,30,0.22)` wash ("slightly").
- **Agent cursor:** SVG pointer; glides (CSS `transform` transition, ~450ms) from its last position to the target element's center.
- **Spotlight hole:** `box-shadow: 0 0 0 99999px <tint>` around a transparent box that follows the cursor — the focused component is the one lit patch. A click plays a pulse/ripple at the cursor tip.

**Choreography** — the injected `focusAndAct(idx, spec)` is `async` and awaited by `executeScript`:
1. move cursor → element `#idx` center; spotlight glides there; element lights up.
2. `await` the ~450ms transition.
3. perform the real interaction (from `pageActions`).
4. play the click pulse.

"Working on" (click/type/select/press) and "viewing" (highlight/scroll-to) both land the cursor + open the spotlight. Bulk `InspectPage` keeps only the flat tint (no per-element strobing) — the set-of-marks screenshot already conveys what it sees.

## 13. Cross-cutting coordination

1. **Persist across stateless injections:** the overlay is a persistent page `<div>`; the cursor's last position rides on `overlay.dataset.cx/cy`, so each new action injection animates *from* where it was. Injections read/update the existing overlay, never recreate it.
2. **Hide during capture:** `InspectPage` hides the presence overlay before `captureVisibleTab` (two rAFs, like `selectRegionInPage`), then restores it — otherwise the tint poisons the vision model's screenshot.
3. **Animate-before-act latency** ~450ms/action is intentional; bounded by the 20-action budget.
4. **Robust teardown:** session end / Stop / deny / error / budget-hit all inject `unmountPresenceOverlay()` + `clearAgentIndex()`. Wired in the turn `finally` and the session-close path — a left-behind tint is the worst failure mode, so teardown is belt-and-suspenders.

## 14. Error handling & guardrails

- **Action budget:** 20/session; exhaustion closes the session and asks the user to continue (runaway-loop backstop).
- **Origin fence:** session bound to its grant origin; landing on a new origin → re-inspect + (cross-origin) re-grant.
- **Stale index:** missing `[data-agent-idx]` → `"element N is no longer on the page, call InspectPage"` (never act on the wrong node).
- **Unscriptable pages** (`chrome://`, Web Store, some PDFs): `executeScript` throws → friendly "can't control this page" (same surface as `readTabContent`).
- **Model loop cap:** `MAX_STEPS` raised to 24; the budget + Stop are the real bounds.
- **React/Vue inputs:** native-setter + dispatched `input`/`change`.

## 15. Security considerations

- No new permissions; `host_permissions: <all_urls>` already granted for reads.
- Every state-mutating capability still passes a human gate: one session grant + individual cards for point-of-no-return actions; Stop always available; visible presence overlay makes agent action obvious.
- Sensitive-field heuristic forces confirmation for passwords/payments even inside a session.
- Session is origin-fenced and action-budgeted; nothing persists across conversations.

## 16. Verification (no test suite)

Per `CLAUDE.md` / the `verify-extension` skill: `npm run build`, reload the unpacked extension, then exercise:
- A vision model and a non-vision model (probe path both ways); confirm set-of-marks vs text-only.
- Fill a multi-field form on a plain HTML page and on a React app (native-setter path); confirm the submit button pops an individual card.
- Highlight/scroll-to a component (read-only show-me).
- Stop mid-session; deny the session; hit the 20-action budget — confirm the overlay always tears down and `data-agent-idx` is cleaned.
- An unscriptable page (`chrome://extensions`) — confirm graceful failure.

## 17. Deferred / future

- `chrome.debugger`/CDP trusted-event fallback for `isTrusted`-gated widgets (new permission + debugging banner; revisit only if real sites reject synthetic events).
- Cross-tab / background orchestration.
- Per-model vision override in Settings (if the runtime probe proves unreliable on some endpoints).
```
