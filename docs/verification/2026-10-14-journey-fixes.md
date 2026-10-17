# Post-merge journey fixes and verification

Follow-up to [the original P1–P3 review](2026-10-14-user-journey.md), on `codex/post-merge-journey-review`, based on the release branch containing merged PR #3. This is development work for a future release, not a replacement of the submitted Chrome Web Store 0.5.0 package.

## Findings addressed

| Priority / finding | Change | Verification |
| --- | --- | --- |
| P1 silent preparation | Every awaited preparation stage is bounded to 30 seconds, labelled without recording content, and cancellable. Errors before the agent loop now reach cleanup and a visible Retry action. Fresh-turn preparation rejects concurrent submissions; cancellation discards late results. | Timeout, cancellation and rejection regression tests; installed Chrome plain chat, Settings → connect → tool invocation, new conversation, extension restart and normal-page attachment all progressed. The original hang's exact external trigger was not conclusively identified; the unbounded waits and missing error boundary are fixed. |
| P1 durable-task erasure | Task records appear in Data usage, per-store clear and full erasure. An IndexedDB generation is checked atomically with writes; delayed creations and polling responses cannot restore cleared records. Poll updates also require the record still to exist. | Manager-level delayed creation/poll races, store-level generation checks, and real browser Data → erase → reopen with zero task records. Tests use disposable storage, never the user's extension data. |
| P1 truthful persistence | Saved appears after persistence succeeds. Settings and skill failures are visible; Data failures retain the screen and permit retry. Research-worker clear failures and blocked/failed vault deletion propagate rather than reporting success. | Mounted React pending/rejected save, successful retry, clear failure and erase failure tests; worker error regression; full suite. |
| P2 task attention/recovery | Visible input-required count, readable status, source-chat action, last update, connection state, disabled unavailable operations and explicit local forgetting with remote-work warning. | Installed task creation, restart recovery, explicit input completion, server-confirmed cancellation, source-chat navigation and removed-server recovery. |
| P2 task output | Text and existing sanitized rich MCP renderer, secondary structured-data view, and explicit Use in chat. Result transfer fills the composer; it does not send a model request. | Installed result retrieval and composer transfer; content/sanitizer regression suite. |
| P2 remote skills | Server-scoped Library metadata discovery, source and description, explicit not-yet-verified status, and Load in chat. Loading retains metadata and exact-manifest approvals and integrity checks; no persistent authorization is introduced. | Installed discovery → composer → metadata approval → manifest approval with digest → verified skill file. Existing tamper/scope/approval tests pass. |
| P2 capability visibility | Dedicated Connections tab shows negotiated protocol and tools/tasks/skills/clarification capability, explains legacy limits, and offers a local connection diagnostic without executing tools. | Installed legacy Notion and modern localhost fixture rows. |
| P2 permission controls | Global task/skill tool policies and server extension-operation overrides; skills/list is enforced by both the agent and Library path. Copy explains one-time approvals under Always. | Permission regression tests, including a new blocked skills/list test. |
| P2 form usability | Required/constraint errors by field, focus on the first error, incoming-request announcement, displayed constraints, and an unambiguous empty-string enum value. Decline and Cancel are explained. | Installed missing-field validation/focus and valid city response; mounted empty-string enum submission regression. |
| P2 URL clarification | Verification-page wording, full destination/host and explicit consent-versus-completion explanation. | Source review plus existing URL validation/queue tests. No external verification account was opened. |
| P2 onboarding | LM Studio preset and bounded model discovery; named steps, accurate provider support, inference destination and context disclosure. | A non-persisting harness running under the actual extension origin discovered local models, tested Gemma successfully and completed all three steps. A normal web-origin harness cannot bypass LM Studio's CORS policy, so it was not used to claim this result. |
| P2 page context | Restricted browser/store pages are excluded from automatic attachment; the composer explains the restriction and distinguishes visible tabs from shared content. | Installed internal-page chat and a normal localhost page with successful source attachment; URL-classification regression. |
| P3 navigation | Connections separated from General; Settings/Library arrows, Home/End, roving focus and tabpanel relationships. Library and task/form content remain scrollable in narrow panels. | Mounted keyboard/tabpanel test and installed side-panel interaction. |
| P3 build identity | Settings shows manifest version plus build commit; dirty builds are marked. | Production build and installed Settings inspection. |

## Automated result

- **2,066 tests across 157 files pass.** Includes mounted interaction/persistence tests and real task-manager delayed-response races.
- TypeScript and both production builds pass; `git diff --check` passes.
- Production dependency audit: **0 advisories** at the verification cutoff.
- Strict-CSP browser fixture passes modern/legacy negotiation, tool schema validation, subscriptions, scope reauthorization and OAuth discovery/DCR/PKCE/issuer validation. Its identity popup is simulated, not a live third-party account login.

## Browser evidence and boundaries

The installed unpacked Chrome extension was rebuilt and reloaded. Browser inference used only LM Studio at `http://127.0.0.1:1234/v1`, model `google/gemma-4-26b-a4b`. Existing user-enabled Langfuse tracing was left unchanged; prompts and fixture content were synthetic. Production code remains browser/service-worker native. Local fixture servers are test infrastructure only.

The real panel successfully ran plain chat, MCP clarification with explicit approval, durable task creation/restart/input/result retrieval, and remote-skill discovery and manifest approval. Cancellation reached the server-confirmed cancelled state; the task link reopened its original conversation. Removing the disposable server exposed the unavailable-connection state and local recovery controls. A normal webpage was attached to the first message and the model replied `PAGE CONTEXT OK.`. The local model initially attempted an unrelated page-action route for a later task request; that permission was denied and the turn was stopped, confirming recovery controls, before targeting the MCP tool explicitly.

Other existing attachment, PDF, artifact, research, memory, OAuth and account-scope behavior is covered by the full automated suite. This is not a claim that every external provider or every research/attachment scenario was manually re-exercised in Chrome. The deterministic fixture and installed-panel tests are recorded separately from live external-account validation.

The original checkout's source status, including excluded ChatGPT-provider work, remains unchanged. The submitted `lychee-ai-v0.5.0.zip` remains unchanged at SHA-256 `5d2eae2b37df8e9d428b8c1447a77db2a404a47b8a7973dbc8ce6428deac7260`. No store submission or publication was performed.
