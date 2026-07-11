# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome Extension (Manifest V3) that renders a model-agnostic AI agent chat in Chrome's native side panel. React 18 + Vite 6 + TypeScript (strict), built on the Vercel AI SDK v5. Runs entirely client-side — **there is no backend**; the panel calls whatever OpenAI-compatible endpoint the user configures directly. See `README.md` for the feature-level tour and the file→responsibility architecture map.

## Source layout

`src/` is grouped by concern — put new files in the matching directory:

- `src/background.ts` — MV3 service worker (the only file at `src/` root; it's a Vite entry point).
- `src/ui/` — React side-panel components (`main.tsx` entry) + `styles.css`.
- `src/tools/` — agent tool definitions and the approval gate; `pageControl.ts` holds the page-control session, the point-of-no-return classifier, and per-action dispatch.
- `src/agent/` — the AI/agent core: turn loop, provider adapter, memory dreaming, and the runtime vision probe (`vision.ts`, caches whether a model reads images in `chrome.storage.local`).
- `src/data/` — persistence & config: settings (`chrome.storage`), memory + conversations (IndexedDB). Data-model interfaces live beside their store.
- `src/platform/` — Chrome/DOM utilities: tabs, screenshot capture, DOM→image, panel port, time, plus page control's `domIndex.ts` (indexed-DOM registry), `pageActions.ts` (click/type/select/scroll/press/navigate), `presence.ts` (on-page tint/cursor/spotlight overlay), and `marks.ts` (set-of-marks screenshot). Functions injected via `chrome.scripting.executeScript` (the `inj*`/`build*` functions in these files) run in the page's isolated world with no shared JS state between injections — keep each one fully self-contained (no closures over outer-scope values, no imports); pass everything it needs as `args` and re-find elements via `data-agent-idx`.

## Commands

- `npm run dev` — `vite build --watch`. Rebuilds `dist/` on change but does **not** hot-reload; after each rebuild you must click the extension's reload button in `chrome://extensions` to pick up changes.
- `npm run build` — `tsc --noEmit && vite build` (type-checks first, fails fast on type errors).
- `npm run typecheck` — `tsc --noEmit`.

Load the extension: `chrome://extensions` → Developer mode → Load unpacked → select `dist/`.

## Verifying a change

There is no test suite. To confirm a change works: run `npm run build`, reload the unpacked extension in `chrome://extensions`, then open the side panel and exercise the affected flow. The `/verify-extension` skill runs this end to end.

## Code style

No linter or formatter is configured — these are convention-only, so match them by hand:

- **No semicolons** (ASI style).
- **Single quotes** for JS/TS strings.
- **2-space indentation.**
- Prefer `interface` for object/record shapes; reserve `type` for unions and aliases.
- Document exported types/functions with `/** ... */`; explain non-obvious *why* in block comments (the codebase does this heavily).

## Architecture invariants

- **Every agent tool must route through the `requestApproval` gate** in `src/tools/tools.ts` before its `execute()` proceeds — this human-in-the-loop card is the security model. New tools go in `createAgentTools()` and must follow it. The sole exception is the internal `Checkpoint` control tool (injected in `runAgentTurn`, `src/agent/agent.ts`, never in `createAgentTools`): it touches no page/network/data and is deliberately ungated — its only job is to end a turn and hand off state; the human gate for *resuming* is the Continue card.
- **`chrome.sidePanel.open()` must be called synchronously** inside the user-gesture handler in `src/background.ts` — no `await` before it, or the browser rejects the call. Chrome has no `sidePanel.close()`; closing is faked by messaging the open panel (named `Port` `"sidepanel"`) to `window.close()` itself.
- **No `.env` / build-time secrets.** API keys are entered at runtime via the Onboarding/Settings UI and stored in `chrome.storage.local`. `host_permissions: ["<all_urls>"]` is what exempts the direct API calls from CORS, so no proxy is needed.
- **Memory & dreaming** (`src/data/memory.ts`, `src/agent/dream.ts`) is timing-dependent: an hourly `chrome.alarms` tick consolidates memories at most once per ~20h and only after 30+ min of user inactivity. Keep this in mind when reasoning about memory correctness.
- **Page control has two nested gates.** `RequestPageControl` opens a per-task `ControlSession` through the `PageControlGate` (`requestSession`/`session`/`endSession`, implemented in `src/ui/Chat.tsx`, typed in `src/tools/tools.ts`); once a session is granted, individual `ControlPage` steps still route back through `requestApproval` a second time when `isPointOfNoReturn()` (`src/tools/pageControl.ts`) flags them — form submits, cross-origin navigation, Enter keypresses, sensitive fields — each as a one-shot card (no "Allow this chat"). The on-page presence overlay (`src/platform/presence.ts`) and the session must always be torn down in the continuation chain's **outer** `finally` (`runTurnChain` in `src/ui/Chat.tsx`, alongside `pageControl.endSession()`) — not per `runAgentTurn` — so they survive seamless auto-continues but are always cleared on completion, error, Stop, or the ask-boundary; tearing down only on the success path leaves a stale tint/cursor.
- **Long-horizon turns are a continuation chain.** `runTurnChain` (`src/ui/Chat.tsx`) loops `runAgentTurn` under a single 24-step budget (`MAX_STEPS`, `src/agent/agent.ts`) that bounds *all* activity — page control included; there is no separate per-session action budget. Near the ceiling, `prepareStep` nudges the model to call the ungated `Checkpoint` tool, which ends the turn with a structured hand-off (`stop.reason === 'checkpoint'`; a hard cut-off is `'budget'`). The chain auto-continues up to `MAX_AUTO_CONTINUES` (foreground) / `RESEARCH_MAX_AUTO_CONTINUES` (headless research, `src/agent/research.ts`) — the session/overlay persist across these — then surfaces the Continue card. Auto-continue only refreshes the *step* budget; point-of-no-return steps still confirm individually every time.

## Git

Commit directly to `main` when asked (small project, no PR flow required).
