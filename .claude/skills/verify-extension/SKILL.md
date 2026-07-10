---
name: verify-extension
description: Build and verify this Chrome extension end to end — typecheck, build, reload the unpacked extension, and exercise the side panel in the browser. Use before claiming an extension change works, since there is no test suite.
---

# Verify the extension

This project is a Manifest V3 Chrome extension with no automated tests. A change is only "verified" once it compiles cleanly AND runs in a real browser. Do all three phases; don't stop at the build.

## 1. Typecheck + build

```bash
npm run build
```

This runs `tsc --noEmit && vite build`. It must exit 0 with no type errors before you continue. If it fails, fix the errors — a green build is the gate, not the goal.

## 2. Reload the unpacked extension

`vite build` only regenerates `dist/`; Chrome will keep running the old code until you reload it. Tell the user to:

1. Open `chrome://extensions`.
2. Ensure **Developer mode** is on and the extension is loaded unpacked from `dist/` (if not: Load unpacked → select `dist/`).
3. Click the **reload** (↻) icon on the "Agent Chat" card.

### Driving it with Playwright (preferred when the MCP tools are loaded)

The `playwright@claude-plugins-official` plugin provides a browser MCP server. Use its tools to load the extension and screenshot the panel yourself instead of asking the user:

- Launch a **persistent, headed** context with the unpacked build loaded — MV3 extensions only load this way, not in a normal page or headless:
  `--disable-extensions-except=<abs path>/dist --load-extension=<abs path>/dist`
- The panel lives at `chrome-extension://<extension-id>/sidepanel.html` — find the id on the `chrome://extensions` card (or the service-worker target), then `navigate` there to render and screenshot the UI.
- **Honest limitation:** the `chrome.*` APIs (`tabs`, `storage`, `sidePanel`, `scripting`) only exist in the real extension context. Opening `sidepanel.html` as a bare page renders the layout but tab-reading, storage, and permission flows will be undefined — for those, drive the actually-loaded extension, or fall back to asking the user.

If the Playwright MCP tools aren't loaded (e.g. the plugin was just enabled and needs a restart), ask the user to reload the extension and report back.

## 3. Exercise the affected flow

Open the side panel (toolbar icon or `Cmd/Ctrl+E`) and actually use the surface you changed — don't just confirm it opens. Depending on the change, check the relevant path:

- **Chat / agent loop** — send a message, watch the streamed response and any tool-approval cards.
- **Tools** (`src/tools/tools.ts`) — trigger the tool, confirm the approval card appears and Allow/Deny behave.
- **Onboarding / Settings** — run the provider live-test, switch tab-visibility scope.
- **Screenshots** (`src/platform/capture.ts`) — the camera button, snipe/drag capture, thumbnail on the composer.
- **Memory** (moon icon) — that memories render; dreaming is background/timing-gated so don't expect it on demand.

Watch the extension's service-worker and side-panel devtools consoles for errors. Report what you actually observed — if you couldn't verify a path in the browser, say so rather than implying it passed.
