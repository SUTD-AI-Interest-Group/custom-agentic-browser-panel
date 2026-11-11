# Application optimisation pass — 11 November 2026

This pass covers the extension, the public website, and the local ChatGPT companion. It preserves the work already present in the checkout, including durable chat, Studio, page watches and the companion. No deployment or account configuration was changed.

The subsequent [background lifecycle audit](background-lifecycle.md) documents additional resource-release fixes and its verification.

## Measured results

The idle comparison uses the same disposable Chrome profile fixture, a local model endpoint, a native WebMCP page and five mounted chats. Measurements start after initial setup and cover 3.2 seconds. Counters instrument the side panel's IndexedDB transactions and `chrome.scripting.executeScript` calls, not every process in Chrome.

| Measurement | Before | After |
| --- | ---: | ---: |
| Idle panel IndexedDB transactions | 61 | 0 |
| Idle panel IndexedDB writes | 0 | 0 |
| Idle panel script injections | 4 | 0 |
| Unrequested model calls across the fixture | 1 | 0 |
| Side-panel entry JavaScript, minified | 764.85 kB | 687.85 kB |
| Side-panel entry JavaScript, gzip | 238.66 kB | 217.31 kB |
| Initial side-panel CSS, minified | 129.77 kB | 116.51 kB |
| Website JavaScript, minified | 442.57 kB | 437.38 kB |
| Website CSS, minified | 28.95 kB | 23.60 kB |

Entry JavaScript decreased by about 10.1%, or 8.9% with gzip. Settings, its six tabs, Library and Studio now load when opened; Studio also has a separate 6.39 kB stylesheet. These are entry-file measurements, not total application transfer or execution time. Shared agent code and document parsing chunks remain large. PDF/Office parsing remains lazy, and its workers now terminate after 30 seconds without use.

The observed heap was lower, but garbage collection was not controlled, so it is not presented as a memory benchmark. No device battery, CPU-percentage or whole-browser energy claim follows from this short fixture.

## Ownership and transitions

| State machine | Owner and simplification | Required behaviour |
| --- | --- | --- |
| Main surface | `App`: one `surface` union replaces overlapping Settings, Studio and Library booleans; Library uses that same state | Exactly one foreground surface; retained chats keep their drafts and running turns, but cannot collect selection or capture input while hidden |
| Onboarding | One provider draft and `idle / testing / done` test state | Changing provider, going back or unmounting cancels the old test; late results cannot validate new inputs |
| Settings | Latest settings plus a local draft/base merge; writes serialized before encryption/storage | Unchanged fields adopt external edits; dirty fields survive; provider rows merge by ID; success appears only after persistence; failure is visible and retryable |
| Chat run | Existing persisted `queued / running / done / error / cancelled` record | Closing the panel does not cancel background work; reopening reattaches; Stop cancels; terminal records do not replay tools |
| Streaming projection | `partsVersion` plus commit notifications | Lease and approval updates do not serialize the entire transcript merely to detect changes |
| Approval/tool wait | Subscribe-before-read mailbox around the durable record | No lost wake-up between read and wait; one-second liveness fallback survives killed contexts; unsubscribe/timers clean up in `finally` |
| Restored chat observation | Coalesced, serial invalidation reads | No idle 250 ms polling; a foreign active run retains a five-second liveness check; changes during a read trigger a trailing read |
| Research | Existing `running / paused / done / error / cancelled` task plus a shared panel subscription | One task read per update per panel; each chat displays and clocks only its own research; cancellation and bounded recovery stay intact |
| MCP connection/task | Existing connection generations, retry state and durable completion receipts | Empty task queues avoid loading/decrypting settings; closed-panel completion and lost-acknowledgement recovery remain exactly once in the fixture |
| Page watch | Existing `active / matched / expired / cancelled / needs_attention`; shared durable database connection | A thrown mutation aborts rather than hanging; no-op changes skip writes; empty queues avoid settings work; temporary tabs still clean up |
| Page actions | Explicit suggestion request with cancellation | Discovery does not call a model; tool refreshes/provider changes clear old suggestions without triggering inference; tool metadata changes invalidate stale actions |
| Selection | One token-scoped listener for the visible chat | Debounced `selectionchange` replaces one-second injection; navigation, tab changes and hiding tear it down; late messages cannot overwrite another tab's selection |
| PDF/Office engine | Existing FIFO, boot and request deadlines plus idle release | No overlapping parsing; idle resources terminate; a crash rejects immediately; the next document creates a fresh worker |
| Website video | Native modal dialog, opened explicitly | No hero autoplay; keyboard focus is contained and returns to the opener on close; Escape closes; page scrolling is restored |

There is no new state-machine framework. Feature-specific machines remain close to the resources they own. Presentation components moved from `Chat.tsx` into `ChatViews.tsx`; `LinkCard` now imports the favicon utility directly, removing its dependency back on the chat controller. The controller is about 1,900 lines shorter, although it still owns substantial orchestration.

## Surface and feature coverage

| Surface or feature | Work and verification |
| --- | --- |
| Chat/composer, tab-bound chats, draft retention | Removed the empty-screen slogan/instruction paragraph and rotating thinking labels. Kept a quiet status indicator. Browser checks cover switching tabs during preparation/generation, retained drafts, notifications, closed-panel continuation, reconnection, Stop and interruption. |
| Attachments, PDFs, Office files, screenshots, code execution | Existing attachment/extraction/sandbox tests pass. Added PDF crash/idle-restart and Office idle-restart tests. Browser checks cover offscreen PDF processing, screenshots, tab APIs and code execution after the panel is destroyed. |
| Rich messages, citations, image/link cards, traces, artifacts | Extracted presentation without changing its contracts. Existing parsing, rendering, sanitization, trace and artifact tests pass. Link previews now coalesce duplicate requests, bound memory to 128 entries and clear stale presentation when URLs change. |
| Onboarding and providers | Consolidated state and test cancellation; shortened labels. Browser surface checks cover first-run UI and provider settings; provider/companion tests cover adapters. Real paid-provider inference and account sign-in were not exercised. |
| Settings: General, Providers, Permissions, Memory, Skills, Data | All six tabs checked in Chrome. Shared accessible tab navigation handles arrows and Home/End. Dirty-field/external-update merge checked in the browser. Kept permission consequences, units and actionable errors; removed repeated explanatory copy. Storage failures no longer silently masquerade as success. |
| Library: Chats, Skills, Research | All three tabs and the skill editor checked in Chrome. Failed history reads can retry; failed writes remain visible. Keyboard events on nested history controls no longer also open the chat. Clipboard export reports success only after the write completes. |
| Memory consolidation | Removed decorative phrasing; preserved interval/model controls, destructive consequences and outcomes. Read/delete/reset failures surface. Existing consolidation tests pass. |
| Research planning, gathering, synthesis, verification and recovery | Shared task observation removes duplicated panel reads. Existing tests cover bounded step payloads, cancellation, deadline fallback, retry classification, structured-output failure and non-fabricated evidence. No live multi-hour research task was run. |
| Browser control and native WebMCP | Twelve real-browser checks pass: discovery, stable identity, single mutation, denial, changed-tool rejection, reload identity, cancellation, deadline and no automatic replay after uncertain completion. |
| MCP tools, resources, prompts, apps and durable tasks | Existing manager, bridge, protocol and completion tests pass. Browser task checks cover database reconnect, closed-panel completion, one continuation and lost acknowledgement without replay. No third-party OAuth account was connected. |
| Studio | Browser checks cover palette/contrast, review/apply, real userScripts, zap, disable/enable, closed-panel reload, browser restart and origin isolation. Removed duplicated headings and promotional empty-state copy. |
| Page watches | Browser checks cover approved setup, background checks, reopening a closed target with the panel closed, matching, single notification and temporary-tab cleanup. |
| ChatGPT companion | Twelve tests pass, including native messaging, storage and loopback sign-in cancellation. Native authorization boundaries remain in place. No installation or real account authorization was performed. |
| Public homepage, setup, engineering log, articles and privacy | Removed autoplay, decorative marquee/counter, repeated labels and captions. Consolidated conflicting hero CSS and fixed mobile columns. Browser checks cover 320/390/768/1440 px, article navigation, section links, malformed URLs and modal focus. Privacy policy content remains intact. |

## Verification

- Extension: **166 test files, 2,055 tests passed**. The initial checkout had 2,035 passes and one failure: the reading permission-group test did not include the existing page-watch tool default. That expectation now covers the current catalogue.
- Companion: **12 tests passed**.
- Extension and website TypeScript/production builds passed. Vite still reports large shared/parser chunks; the warning was not suppressed.
- `git diff --check` passed.
- Browser scripts passed: `test-background-chat-browser.mjs`, `test-closed-panel-chat-browser.mjs`, `test-background-tools-browser.mjs`, `test-mcp-tasks-browser.mjs`, `test-page-watches-browser.mjs`, `test-studio-browser.mjs`, `test-webmcp-browser.mjs`, `test-html-extraction-browser.mjs`, `test-product-surfaces-browser.mjs`, `test-site-browser.mjs`.

Reproduce with an installed Chrome for Testing that supports the native WebMCP fixture:

```sh
export CHROME_BIN='/absolute/path/to/Chrome for Testing'
npm test
npm --prefix companion/chatgpt test
npm run test:surfaces:browser
npm run test:webmcp:browser
npm run test:site:browser
```

Other browser scripts use the same `CHROME_BIN` and the current `dist` build. Run builds before browser checks rather than rebuilding while a test is reading `dist`. Screenshots and fixture measurements are under `test-results/product-surfaces`, `test-results/product-surfaces-baseline`, `test-results/site-surfaces` and `test-results/webmcp` (ignored generated artifacts).

For the idle comparison, `test-product-surfaces-browser.mjs` also accepts `EXTENSION_DIR`, `OUTPUT_DIR` and `BASELINE=1`. The pre-pass build used here is preserved locally at `/tmp/lychee-optimisation-baseline-dist`; baseline source snapshots and logs are also under `/tmp/lychee-optimisation-*`.

## Practical limits

The suite and local fixtures provide regression evidence, not proof that every site, provider, browser lifecycle or long-running task is correct. Real OAuth/provider quotas, low-memory devices, physical touch interaction and long-duration battery/memory profiling remain unverified. The main remaining architectural weight is the chat orchestration and shared agent/parser dependencies. Splitting those further should preserve the durable execution boundary and be justified by a measured loading or maintenance benefit.
