# PR #3 security and production verification

Date: 2026-10-14. Reviewed feature commit: `ac9c82a`; remediation is the commit containing this report. PR: https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/pull/3.

## Recommendation

The identified approval-boundary issues are fixed, with regression coverage. No remaining merge blocker was identified within the tested scope. This is a recommendation to merge the feature into its existing release-branch base, not a claim of live-server interoperability or approval to publish. PR #3 remains a draft and targets `codex/mcp2-browser-subscriptions-webmcp`, not `main`. GitHub reports no CI checks on this PR; evidence below is local.

Before publishing a new release, perform a signed-in Chrome extension smoke test against a representative real modern MCP server, including URL elicitation, OAuth account switching, and reopening the actual side panel. The test package still reports 0.5.0; assign a new release version before a future store upload. The already-submitted 0.5.0 ZIP was not replaced.

## Findings and fixes

| Severity | Finding | Remediation and evidence |
| --- | --- | --- |
| Medium | ListMcpTasks exposed locally saved metadata from an earlier credential session to the model when the same server name remained enabled. | Filter by live connected server and exact credential scope, as well as task policies. Regression tests retain both old and current records and expose only the current record. Local user-visible records remain available. |
| Medium | Extension tool checks used a captured settings snapshot, and task helpers consulted `skills/read` instead of task policies. A policy revoked during a pending clarification was not enforced by the task manager. | Manager retains current MCP policy settings and enforces tasks/get, tasks/update and tasks/cancel at operation boundaries. Skills recheck live policy after approvals and reads. Tests verify revocation closes a pending clarification and sends no tasks/update. |
| Medium | Supporting-file reads checked connection identity before approval but only after fetching afterward; main skill loading checked scope but not exact client before reading. | Recheck both credential scope and exact client immediately after approval and again before returning data. Tests replace the client during manifest/file approval and assert no resource read occurs. |
| Low | A task could expire while the user was answering a clarification, then still send the answer. | Recheck original saved TTL after user input and at each task boundary. Regression confirms zero tasks/update requests after expiry. |
| Low | Large base64 skill data used a repeated-group regex susceptible to JavaScript regex stack exhaustion; metadata recursion and response allocation were unnecessarily permissive. | Use flat base64 validation, limit frontmatter nesting to 32, and scale wire-response allowance to approved file size plus bounded envelope overhead. A 1 MiB base64 regression passes; oversized nesting is rejected. |

No critical/high finding was identified. Severity is a local review assessment, not a third-party audit certification.

## Security coverage

- Elicitation: restricted primitive schemas; executable constraints and credential-shaped form requests rejected; HTTPS links without embedded credentials; URL decisions cannot include form data; whole-batch validation; fresh JSON-RPC IDs and exact opaque state; no state-only replay; close/abort cleanup; concurrent request identity isolation; decline/cancel without content.
- Durable tasks: explicit negotiated extension; IndexedDB handle recovery without replaying original tool; endpoint/credential session binding; no stored answers or completed results; TTL rejection; advisory polling intervals; no automatic response to input_required; cooperative cancellation; terminal state checks; task policy revocation.
- Skills: capability checks, explicit one-time metadata and manifest approvals, manifest-bound supporting reads, no direct fetch of resource URIs, SHA-256/size/frontmatter verification, duplicate identity rejection, invented handle rejection, dynamic manifests refused, no automatic code execution or permission expansion. Content remains untrusted even after integrity succeeds.
- Existing authentication and transport tests cover credential isolation, OAuth discovery/PKCE/issuer validation, explicit insufficient-scope authorization, legacy fallback and strict-CSP schema validation.

The credential-word filter is a defense in depth heuristic, not a guarantee that arbitrary server prose cannot solicit sensitive data. The UI warning and explicit user consent remain necessary. A skill digest proves agreement with approved metadata, not trustworthiness of the author. Local task metadata (IDs, tool names, status messages) remains in extension IndexedDB; it is not a secret vault.

## Verification results

| Check | Result |
| --- | --- |
| `npm test` | **2,052 tests passed across 154 files**, including 12 added adversarial/regression tests. |
| `npm run build` | TypeScript and both production Vite builds passed. Existing large-chunk advisory remains; no build failure. |
| `npm audit --json` | Zero known vulnerabilities at test time. |
| `git diff --check` | Passed. |
| Manifest comparison to PR base | No permissions or CSP changes. |
| Isolated production archive | `/tmp/lychee-pr3-review.zip`: 89 files, 6,220,992 bytes; required entry points/icons present; manifest at root; no source maps, .env files or Finder files; ZIP integrity passed. |
| Submitted release archive | SHA-256 unchanged: `5d2eae2b37df8e9d428b8c1447a77db2a404a47b8a7973dbc8ce6428deac7260`. |
| Primary checkout | NUL-delimited git status matches pre-work snapshot; ChatGPT provider work untouched. |

Review archive SHA-256: `7d6ab6ea9f598e3bc56960e09f4006135d364c7d6d4ebbff0b44d83bfefebce3`. This is a review artifact, not the submitted store artifact.

### Browser evidence

Ran `node scripts/mcp-browser-smoke.mjs` and exercised the local fixture in the Chromium-based in-app browser under CSP without unsafe-eval. Browser-visible results:

- Modern and legacy negotiation and tool/schema validation passed over real HTTP.
- Subscription acknowledgement and resource update passed.
- Insufficient-scope authorization and OAuth discovery/DCR/PKCE/issuer callback/token exchange passed with a simulated identity popup.
- Decline returned only `{action:"decline"}`.
- A saved task survived page reload, remained input_required, then completed after explicit selection and submission; its result was readable.
- Valid skill content verified; changed content failed integrity validation.

The fixture uses real browser fetch, Web Crypto, IndexedDB and the actual clarification/task React components. Chrome identity/storage are shimmed. Skill approval race and denial checks are automated unit tests, not full Chat approval-card browser tests. No external accounts, hosted model calls, production task mutations, or middleware service were used. The fixture process was stopped afterward.

Screenshot is retained in the Codex task artifacts as `pr3-security-browser.jpg`.

## Remaining limits

- Full installed-extension end-to-end testing with real OAuth and modern MCP servers remains unverified in this review. Prior user testing of 0.5.0 does not cover this new feature branch.
- Task polling is panel-resident; server work can continue while the panel is closed. Cross-window coordination, Chrome process termination, long-duration soak, and server retention races were not exhaustively exercised.
- URL elicitation validation is unit-tested; the real third-party authorization page and Chrome tab-opening flow were not exercised here.
- Dynamic skills, directory listing, binary skill attachments and task push notifications remain unsupported as documented in the feature PR.

## Specification references

Reviewed against the official [elicitation specification](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation), [Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview), and [Skills extension](https://modelcontextprotocol.io/extensions/skills/overview), retrieved 2026-10-14.
