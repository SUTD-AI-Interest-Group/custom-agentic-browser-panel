# MCP development handoff

Reconciled 16 October 2026. This index describes the development branch, not the installed Chrome Web Store release. The implementation last tested in Chrome is `b20e8ff`; the handoff changes only documentation.

## Implementation and artifacts

| Area | Implementation guide / evidence | Status |
| --- | --- | --- |
| Page-native WebMCP | [Feature guide](features/webmcp.md) | Committed WebMCP implementation retained; no competing adapter. |
| Modern MCP, OAuth and subscriptions | [Transport and configuration](mcp-update-subscriptions.md), [security/build verification](verification/2026-10-14-deployment.md) | Browser-native networking and Chrome identity; no middleware or new Chrome permissions. |
| Clarification, durable tasks and skills | [Feature boundaries](mcp-interactive-tasks-skills.md), [PR #3 security review](verification/pr-3-security-production.md) | PR #3 merged into the release branch. Execution stays on the originating MCP server; local handles resume without replaying the original call. |
| P1–P3 journey fixes | [Original findings](verification/2026-10-14-user-journey.md), [resolution and verification matrix](verification/2026-10-14-journey-fixes.md) | Implemented in PR #4, including bounded preparation, atomic task erasure and approval/persistence UX. Original review is historical; use the resolution matrix for current status. |
| Store submission | [0.5.0 package handoff](verification/0.5.0-publishing.md), [listing](../CHROMEWEBSTORE.md), [changelog](../CHANGELOG.md) | Submitted 14 October with manual publishing. Store status has not been rechecked on 16 October. |

Implementation, regression tests, browser fixtures and verification reports are versioned together. Historical plans under `docs/superpowers/` are design records rather than a current release checklist.

## GitHub integration state

Verified against GitHub on 16 October:

- [PR #2](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/pull/2): draft, `codex/mcp2-browser-subscriptions-webmcp` → `main`. Release branch head is `6749ecc`, including merged PR #3.
- [PR #3](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/pull/3): merged into that release branch, not `main`.
- [PR #4](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/pull/4): draft, `codex/post-merge-journey-review` → release branch. Includes all P1–P3 fixes plus this documentation handoff.

The complete development snapshot is PR #4's branch. Integrate PR #4 before PR #2 so the fixes reach `main` together. Both open PRs were mergeable at this cutoff; no GitHub status checks were reported for PR #4. Pushing the branch does not merge either PR or publish a store package.

The primary checkout contains separate, uncommitted ChatGPT-provider/native-companion work. It is excluded and left untouched under the existing scope decision. Do not bulk-stage that checkout or use its source tree to package this release.

## Verification and reproduction

The 14 October final implementation verification recorded **2,066 passing tests across 157 files**, successful TypeScript and both production bundles, and zero production dependency advisories at that cutoff. Installed Chrome testing used local LM Studio/Gemma and covered chat, clarification, task restart/input/result/cancellation, source-chat recovery, remote-skill manifest approval and page context. Disposable browser storage verified erasure without deleting user data. See the linked reports for exact boundaries; these results are not a new 16 October browser run.

From a clean checkout of the complete development branch:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm audit --omit=dev
git diff --check
node scripts/mcp-browser-smoke.mjs
```

The last command starts a localhost fixture and prints its URL; open it in a browser to run the CSP/transport harness, then stop the process. Merely starting the server is not a passing browser test. The fixture uses simulated Chrome identity/storage for OAuth, not a real external account. Interactive fixtures are in `tests/mcp-browser/`; installed-extension testing must use the local model settings in [CLAUDE.md](../CLAUDE.md). Never run destructive storage tests against the user's profile.

Live external-provider OAuth/interoperability and the public optional CIMD document remain separate release checks. No server credential, local model key, user conversation or private tracing output is included in this handoff.

## Package boundary

The submitted `lychee-ai-v0.5.0.zip` is intentionally ignored by Git and remains unchanged:

```text
SHA-256 5d2eae2b37df8e9d428b8c1447a77db2a404a47b8a7973dbc8ce6428deac7260
```

Its hash was rechecked on 16 October. It does not contain PR #3/#4. Development still identifies as 0.5.0 plus its build commit; a subsequent store update needs a new version, fresh release checks and a new archive. Do not run `npm run package` over the preserved submitted ZIP. Do not treat an unpacked development build as the reviewed store artifact.
