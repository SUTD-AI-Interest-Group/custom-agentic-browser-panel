# User journey review after PR #3 merge

## Build and outcome

PR #3 was merged into `codex/mcp2-browser-subscriptions-webmcp` at `6749ecc227c16cd94f313ed9944922742ac3eadb` on 2026-10-14. It was not merged into main. This review ran against that merge commit. The production build was copied into the existing unpacked Chrome extension's generated `dist/` directory, and Chrome was reloaded and visibly confirmed version 0.5.0. The original installed build was backed up before replacement. No ChatGPT provider source changes were included.

**Outcome: merge complete; automated verification passes; full user journey is not yet a clean pass.** The installed-extension test uncovered a silent non-progressing chat path. Source review also found the new durable-task store absent from full data erasure. These should be resolved before the next publication, despite the green protocol tests.

## Evidence and coverage

| Journey | Verification | Result |
| --- | --- | --- |
| Update existing installation | Built merged commit, backed up old dist, copied an exact clean production tree, reloaded Chrome | Passed; Chrome shows 0.5.0 and the panel opens with existing configuration. |
| First-run onboarding | Source review and existing automated tests; existing profile was deliberately not reset | Endpoint validation, provider-key isolation and test-before-continue covered. Fresh-install UI completion not exercised. |
| Select provider and send a basic message | Actual installed Chrome panel, LM Studio local Gemma model | Passed; synthetic prompt returned `LOCAL CHAT OK.` |
| Continue chat / start a new tool journey | Actual installed Chrome panel after adding the disposable local MCP server | **Failed observed journey**: user message appears, but no assistant answer, approval, visible error, or Stop button follows. Reproduced in fresh conversations and after extension reload. Exact cause remains unconfirmed. |
| Connect MCP server | Actual Settings form, local HTTP fixture | Passed; connection appears as Connected. Test server removed afterward. |
| Invoke MCP clarification through model and approval card | Actual installed panel with local Gemma | Blocked by the non-progressing chat above; do not count this as passed. |
| Elicitation / task recovery / skill integrity | Existing protocol/component tests plus strict-CSP browser fixture | Automated tests pass; browser fixture shows negotiation, validation, subscriptions and simulated OAuth passing. Earlier PR3 fixture interaction evidence remains in the security report; this is distinct from actual installed-panel invocation. |
| Task completion, rediscovery, cancellation and account switching | Source review plus task regression tests | Protocol tests pass. UX gaps: tasks are under a collapsed details section; stale-account/removed-server working records cannot be dismissed unless terminal or expired. |
| Skills discovery and activation | Source review plus approval/integrity regression tests | Integrity and approval boundaries covered. Remote skills are not surfaced in the existing local Skills Library or slash menu. Full installed approval-card journey not verified. |
| Page context and permissions | Installed composer and Permissions screen; source review | Controls are available, but restricted Chrome pages still receive an auto-attach pill. Permission copy needs clearer exceptions for automatic context and always-ask actions. No user websites were changed. |
| Attachments / artifacts / research / memory | Source review and full automated suite | Automated coverage passes. No new end-to-end PDF, screenshot, artifact, research or memory-write tests were performed in this review. |
| Data deletion and recovery | Installed Data screen inspected; erase implementation reviewed; no real data erased | **Gap confirmed in code**: the MCP task database is not included in storage accounting or eraseAllData. Clear/erase failures are also swallowed in the UI. |

Validation: **2,052 tests passed across 154 files** on the merge commit; TypeScript and both production builds passed. The test server is a localhost conformance fixture, not a production middleware dependency. The only model used for browser testing was local `google/gemma-4-26b-a4b`. Existing user-enabled Langfuse observability remained enabled, so these were local inference tests, not a claim of zero external telemetry. Test prompts contained synthetic content.

## Release blockers to investigate/fix

### P1: A submitted turn can leave the user without progress or recovery

Observed sequence: update extension → select local model → basic chat succeeds → Settings → add a local MCP server → submit a tool request. The user bubble appears but the flow does not reach an approval or a response. New conversations on both a Chrome internal page and the local fixture page showed the same symptom. Reload did not establish successful MCP invocation. Console inspection showed Notion discovery 404s and existing tracing messages, but did not establish a cause for the stalled turn; do not attribute it to Notion or the local model without further tracing.

Investigate preparation between `startFreshTurn`, `buildUserTurn`, and `runTurnChain` in `src/ui/Chat.tsx`. Preparation includes several awaited operations before the main error/finally boundary. Add a bounded, cancellable “Preparing request” state, visible failure details and Retry. Instrument each preparation stage without recording content. Acceptance: plain chat and tool requests work after Settings changes, new chat, page switching and extension restart; injected preparation failure/timeout always yields an actionable error and clears busy state.

### P1: “Erase all data” leaves durable MCP task metadata behind

`src/mcp/tasks.ts` opens `lychee-mcp-tasks`; `src/data/storage.ts` composes a fixed set of clearers that does not include it. `src/data/usage.ts` and `src/ui/settings/DataTab.tsx` also omit this store. The Data screen's broad erase promise is therefore incomplete. Task IDs, server names, status messages and conversation associations can survive an erase.

Add a task clear/usage API and integrate it into StoreKey, accounting and erasure. Coordinate with active polling/in-flight writes so cleared records cannot reappear. Clarify that clearing local records does not cancel server work. Acceptance: seed a task, erase in a disposable profile, reopen, verify no task records or status metadata survive, including a delayed polling response racing the erase.

## Prioritized UX improvements

| Priority | Surface | Recommendation and success criterion |
| --- | --- | --- |
| P1 | Settings/Data success feedback | `Settings.tsx` flashes Saved before asynchronous persistence completes; `DataTab.tsx` catches and discards clear/erase errors. Await success and show recoverable failure. A simulated storage failure must never display successful save/erase or return to onboarding as if all data was gone. |
| P2 | Task attention and recovery | Add a visible “Needs your input” count, readable status labels, originating chat link, last update and connection state. Allow explicitly forgetting inaccessible records with a warning that remote work continues. Keep Respond and result retrieval discoverable without opening each task. |
| P2 | Task results | Replace raw JSON-only preview with the existing MCP content renderer and an explicit “Use in chat” action. Keep sensitive results out of model context until requested. |
| P2 | Remote skills | Add a server-scoped remote-skills section with source, description, verification status and a clear Load action. Distinguish local reusable skills from per-turn remote approvals; do not silently persist authorization. |
| P2 | MCP capability visibility | The connection row only says Connected/HTTP. Show protocol version and supported tools, elicitation, tasks and skills. Explain unsupported legacy capabilities and provide a harmless connection diagnostic. |
| P2 | Permission matrix | Expose the new extension operations in the user-facing permissions UI. Task get/update/cancel and skills/read are enforced internally but are not obvious controls in the current catalog. Explain why one-time sensitive approvals still appear under Always. |
| P2 | Clarification forms | Show per-field errors, preserve focus, announce incoming requests, and explain Decline versus Cancel. Support empty-string enum selections correctly: the current single-select handler maps empty string to undefined. Display numeric/string limits before submission instead of only a generic validation error. |
| P2 | URL clarification | Say “Open HTTPS page” or “Open verification page”; HTTPS alone is not a trust guarantee. Show the full destination/domain and explain that Continue records consent rather than proving completion. |
| P2 | First-run setup | Add a local LM Studio preset and model discovery, describe inference destination and context sharing before the first test, and make the three steps accessible by name. The current provider description only mentions OpenAI-compatible endpoints even though Anthropic is also offered. |
| P2 | Automatic page context | Avoid attaching restricted chrome:// pages by default; show why they cannot be read. Make the difference between tab visibility, automatic first-message attachment and individual tool approval explicit. |
| P3 | Navigation and accessibility | Move MCP connections out of the long General/system-prompt page into a dedicated Connections surface. Complete keyboard arrow navigation/tabpanel relationships for tab lists and test focus/announcements at narrow side-panel widths. |
| P3 | Build identity and support | Show extension version plus development commit in Settings. The old loaded build initially said 0.4.0 while newer source branches existed, making reproduction ambiguous. |

## Suggested implementation order

1. Diagnose and regression-test the silent turn; complete actual installed-extension elicitation, task and skill approval journeys.
2. Fix task erasure and truthful persistence feedback; verify in a disposable profile, never the user's real data.
3. Improve task attention/recovery and remote-skill discovery.
4. Refine onboarding, connection diagnostics and narrow-panel accessibility.

These are recommendations and verified gaps, not claims that the proposed improvements have already shipped. The tested merge remains unchanged. A small fixture-only change advertises its existing harmless clarify/job actions so they can be exercised through real extension tool discovery.
