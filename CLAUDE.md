# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome Extension (Manifest V3) that renders a model-agnostic AI agent chat in Chrome's native side panel. React 18 + Vite 6 + TypeScript (strict), built on the Vercel AI SDK v5. Runs entirely client-side — **there is no backend**; the panel calls whatever OpenAI-compatible endpoint the user configures directly. See `README.md` for the feature-level tour and the file→responsibility architecture map.

## Source layout

`src/` is grouped by concern — put new files in the matching directory:

- `src/background.ts` — MV3 service worker (the only file at `src/` root; it's a Vite entry point).
- `src/ui/` — React side-panel components (`main.tsx` entry) + `styles.css`.
- `src/tools/` — agent tool definitions and the approval gate.
- `src/agent/` — the AI/agent core: turn loop, provider adapter, memory dreaming.
- `src/data/` — persistence & config: settings (`chrome.storage`), memory + conversations (IndexedDB). Data-model interfaces live beside their store.
- `src/platform/` — Chrome/DOM utilities: tabs, screenshot capture, DOM→image, panel port, time.

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

- **Every agent tool must route through the `requestApproval` gate** in `src/tools/tools.ts` before its `execute()` proceeds — this human-in-the-loop card is the security model. New tools go in `createAgentTools()` and must follow it.
- **`chrome.sidePanel.open()` must be called synchronously** inside the user-gesture handler in `src/background.ts` — no `await` before it, or the browser rejects the call. Chrome has no `sidePanel.close()`; closing is faked by messaging the open panel (named `Port` `"sidepanel"`) to `window.close()` itself.
- **No `.env` / build-time secrets.** API keys are entered at runtime via the Onboarding/Settings UI and stored in `chrome.storage.local`. `host_permissions: ["<all_urls>"]` is what exempts the direct API calls from CORS, so no proxy is needed.
- **Memory & dreaming** (`src/data/memory.ts`, `src/agent/dream.ts`) is timing-dependent: an hourly `chrome.alarms` tick consolidates memories at most once per ~20h and only after 30+ min of user inactivity. Keep this in mind when reasoning about memory correctness.

## Git

Commit directly to `main` when asked (small project, no PR flow required).
