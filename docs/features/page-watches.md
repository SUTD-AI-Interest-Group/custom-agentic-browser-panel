# Page watches

Ask Lychee to watch a component: “Watch this registration button every 5 minutes until 6 PM today; notify me when it becomes enabled.” Both an interval and a deadline are required. The agent must ask for missing timing rather than inventing defaults. The approval card shows the URL, component selector, exact condition, cadence, and deadline before activation.

Use the composer camera to attach a component screenshot, or ask the agent to use `GetElementScreenshot`. These images supplement setup context for a vision-capable model; they do not replace a stable DOM target. Without an image, the agent inspects the page using `ReadPage`. If it cannot identify one component, it should ask the user to select it with the camera. `CreatePageWatch` accepts an optional `screenshotId` from an agent capture, validated against the conversation and page. Uploaded/composer images are already part of conversation context and do not need a shot ID.

The initial version supports case-sensitive text contains, text equals, text changed from the initial baseline, and enabled/disabled controls. Whitespace is normalized. Visual-only chart interpretation, cross-origin frames, shadow DOM targeting, arbitrary JavaScript predicates, and disappearance detection are not supported. Already-matching conditions return the current observation without creating a watch.

`CreatePageWatch`, `ListPageWatches`, and `CancelPageWatch` are discoverable agent tools. Ask “show my watches” or “cancel this watch” in the same conversation. Tool permissions appear under Reading in Settings. Setting CreatePageWatch to Never cancels scheduled activity on the next scheduler tick. Deleting the conversation removes its watches; erasing conversation data also clears watches.

## Background behavior

Chrome alarms check due watches every minute, processing up to three per tick. Requested intervals have a 60-second minimum and a 24-hour maximum. At most 20 watches may be active. Timing is best effort and can be delayed by browser throttling or load. Deadline checks happen before reading and before accepting results. Missed intervals are not replayed.

Each check loads a fresh copy of the saved HTTP(S) URL in an inactive temporary tab using the current browser profile. This refreshes server-rendered pages without reloading the user's original tab, and works after that tab closes. The worker closes checking tabs afterward; activating one transfers it to the user. Session-scoped ownership prevents cleanup from closing reused tab IDs after a browser restart. Persistent leases recover interrupted checks.

The page must reproduce the component from its URL and current session. Unsaved state, expired sessions, redirects, ambiguous/missing targets, changed element types and access failures pause the watch as `needs_attention` and send a notification. Inspect the issue, then cancel/recreate the watch. Checks do not sign in, click, submit forms, or call a model. Page loads still execute the site's normal scripts.

The browser must be running and the computer awake. Watches survive restarting Chrome, but expired watches will not run on resumption. Changes that appear and disappear between checks can be missed.

A match records the observation, sends a desktop notification, and ends the watch. Clicking the notification opens its URL. OS notification settings may suppress visible toasts. The same notification ID is reused when delivery retries after an interruption; there is no distributed exactly-once guarantee. `ListPageWatches` exposes the persisted outcome even if notification delivery fails.

## Verification

- `npx vitest run src/background/pageWatches.test.ts src/tools/pageWatches.test.ts`
- `npm run build`
- `node scripts/test-page-watches-browser.mjs`

The browser regression uses a local fixture, real extension storage, real inactive tab reads, and closed-tab reopening. It captures notification API calls rather than verifying an OS toast. It invokes a due scheduler poll directly rather than waiting for a wall-clock Chrome alarm. It does not test model interpretation quality or screenshot recognition.
