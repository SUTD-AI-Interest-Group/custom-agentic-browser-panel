# Studio Mode

The paintbrush beside **New chat** opens a site-specific Studio with Selectors above Agent Chat.

- Font tiles and a two-handle palette apply immediately. The background handle moves the paired text hue with it; drag the Text handle to change the relative pairing. Both handles support arrow keys (Shift for larger steps), with sliders as an alternative. Auto-pair restores the complementary relationship. Light/dark switches the generated palette.
- Zap stays active after each click. Hover and click more elements, then press Escape or click Zap again to stop. Zapped elements appear as safe miniature previews with a readable label, component type, and restore button. No captured HTML is executed. Existing selector-only saves remain supported.
- Code opens CSS and JS tabs. **Save & apply** persists both editors. CSS applies immediately; JavaScript runs once on subsequent page loads.
- Agent Chat shares the main chat’s Markdown renderer, user bubbles, model picker, and fixed composer. Enter sends; Shift+Enter inserts a newline; Stop cancels generation. The current site is attached as a bounded structure snapshot. Agent replies include a review card for complete replacement CSS/JS. Nothing generated is applied until **Save & apply**. Unsaved drafts survive tab changes while Studio remains open.
- **On/Off** removes/restores styles and unregisters/registers JavaScript. Reload to undo DOM changes or listeners from JavaScript that already ran.

Customizations live in `chrome.storage.local` under `studio:<origin>` and apply to all paths of that exact scheme/host/port. The background worker restores styles when pages load and when Chrome starts, without requiring an open panel. CSS uses the user stylesheet origin, so site CSP does not block it. Saved user scripts are re-registered on worker startup and after extension updates. On Chrome 135+, a guarded USER_SCRIPT execution also covers tabs that loaded before startup registration completed. The guard prevents duplicate execution in the same document, including worker restarts. Saving a script still requires a page reload to run it.

JavaScript uses Chrome's `userScripts` API in the isolated `USER_SCRIPT` world with DOM access. Saving JavaScript requests the optional userScripts permission. Enable **Allow user scripts** in Chrome's extension details if prompted (older Chrome uses Developer mode). Page JavaScript globals are not exposed to this isolated world.

Only HTTP/HTTPS top-level pages are supported. Browser-owned/restricted pages, iframe contents, and shadow roots are not editable through these controls. Zap prefers unique element IDs, otherwise it saves a structural selector; major site layout changes can invalidate those selectors. Generated palettes target common semantic containers and text, rather than interpreting every site's design system.

## Paired-color design

The pair is generated in [OKLCH](https://www.w3.org/TR/css-color-4/#ok-lab), with opposing hues as the default harmony. This is a design choice, not a claim that complementary hues guarantee readability. Out-of-gamut colors are brought into sRGB by reducing chroma while preserving hue/lightness; output is quantized to the exact hex colors used in CSS. Text lightness then moves toward the appropriate extreme until the measured pair reaches at least **7:1** using the [WCAG relative-luminance contrast formula](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). The UI reports this pair’s actual contrast. This is not a whole-page accessibility certification: custom CSS, images, gradients, embedded frames and site-specific effects can change rendered contrast.

## Verification

- `npx vitest run src/background.test.ts src/data/studio.test.ts src/platform/studio.test.ts src/data/studioPalette.test.ts`
- `npm run build`
- `node scripts/test-studio-browser.mjs` (`CHROME_BIN` can specify an installed Chromium executable).

The browser fixture exercises a real AI SDK request/response through a deterministic local OpenAI-compatible endpoint, rendered Markdown, review-before-apply, actual Chrome userScripts registration, a working DOM event listener, continuous Zap, Escape/toggle-off, previews/restoration, strict CSP, closed-panel reload, complete browser restart, once-per-document execution, and origin isolation. The disposable test extension pregrants the optional userScripts permission and switches on Chrome’s actual Allow user scripts control. It does not validate a paid/live provider account or Dia’s native optional-permission prompt. The background test’s imported subsystems are mocked at their installation boundaries, matching the suite’s existing isolation contract.
