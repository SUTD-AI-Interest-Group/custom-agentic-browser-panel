# Optimisation integration — 11 November 2026

Integration base: `main` at `bb02721` and `codex/optimisation-background-cleanup` at `9d93a4f`. Both histories are retained in the merge. The submitted 0.5.0 store archive is unchanged; this is a source integration, not a store release.

## Decisions made during integration

- Keep `main`'s 0.5.0 version, patched dependencies, modern MCP transport/OAuth/subscriptions, interactive clarification, durable modern tasks, verified remote skills, Connections tab, model discovery, bounded chat preparation and persistence feedback.
- Keep the optimisation branch's durable background chat, Studio, page watches, local companion, lazy surfaces, single foreground-surface state, change notifications and resource cleanup.
- Keep both MCP task protocols. They previously used the same database/store name for incompatible records. Database version 3 atomically moves nested SDK records into `sdkTasks`, preserves modern records in `tasks`, and creates shared deletion metadata. Both contribute to storage accounting and deletion. Epoch checks reject delayed task creation after erasure. Closing a stale connection reopens it without replaying a mutation.
- Route worker-owned MCP clarifications to the trusted side panel through an explicit runtime bridge. Requests and responses stay in memory; content scripts cannot read or answer them. Reopening the panel reattaches to pending input. Cancellation removes the pending request.
- Wait for live MCP catalogs before building background tools. `main` deliberately stopped trusting unscoped cached catalogs; restoring that old behaviour would undo its security fix. Waiting for the live catalog also fixes missing tools in a fresh worker and restores SDK task completion after panel reopening. Stop can detach the connection waiter.
- Keep modern task polling dormant when no connected, nonterminal task needs it. Storage/connection notifications schedule work; teardown aborts checks and clears timers/listeners.
- Combine Settings' draft merge with serialized writes, latest-save feedback and retry. Keep the shared keyboard tab component and all seven Settings tabs. Keep remote skill transfer through the controlled Library surface. Provider discovery now aborts when its inputs/lifetime change.

## Dependency checks

The initial combined lockfile had eight audit findings. Compatible updates cleared seven; the remaining Zod advisory required moving to 4.6.7 and specifying string keys in record schemas. See the [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) and [migration guide](https://zod.dev/v4/changelog).

The verified lockfile retains MCP SDK 1.32.1, Office parser 8.1.1, pdf.js 6.4.299 and KaTeX 0.18.10, with Vite 6.4.6, Vitest 4.1.12 and DOMPurify 3.4.17. Full dependency audits report zero vulnerabilities for the extension, website and companion at this cutoff.

## Verification

- Extension: **2,229 tests across 182 files pass**. This includes both protocol suites, v1/v2 task migration, preservation of saved results, cross-protocol erasure, delayed-write rejection and clarification-bridge access/cancellation.
- Companion: **12 tests pass**.
- Extension TypeScript and production builds pass; website TypeScript/production build passes. Existing large shared/parser chunk warnings remain visible.
- Browser surface checks cover all seven Settings tabs, three Library tabs, Studio, onboarding, draft/external-settings merge and responsive layouts. The five-chat idle fixture still records **zero panel database transactions, writes, script injections and unrequested model calls** during its 3.2-second window.
- Existing Chrome fixtures pass for background chat, closed-panel recovery and Stop, background tools, concurrent research cleanup, SDK task completion and lost acknowledgement, page watches, Studio/browser restart, native WebMCP, hostile HTML extraction and the website.
- The new `test-merged-mcp-browser.mjs` fixture passes background clarification across actual panel closure/reopening, explicit user response, modern task persistence/input/completion without recreating the job, remote-skill discovery/draft transfer, and idle offscreen-host closure.
- The existing MCP browser conformance fixture passes modern/legacy negotiation, tool/schema checks under CSP, subscriptions, explicit additional-scope consent and OAuth discovery/DCR/PKCE/issuer validation/token exchange. Its identity popup is simulated.
- `git diff --check` passes; no conflict markers remain.

Build once before running the browser fixtures against `dist`; do not rebuild it while a fixture is using it. `CHROME_BIN` points to an installed Chrome for Testing. The new combined fixture runs with:

```sh
npm run build
node scripts/test-merged-mcp-browser.mjs
```

The [initial optimisation measurements](../optimisation.md) and [cleanup inventory](../background-lifecycle.md) remain dated records of the earlier pass. Bundle figures there predate this integration, dependency updates and additional wiki content. These local checks do not establish live paid-provider/account interoperability, physical-device battery savings or long-duration memory behaviour.
