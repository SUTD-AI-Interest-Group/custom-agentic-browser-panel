# Main merge verification — 17 October 2026

PR #4 merged into `codex/mcp2-browser-subscriptions-webmcp` at `c471c85943690e8cbdd5e4f8fef34e94d188d7f6`. PR #2 then merged into `main` at `594fb9b35f23ef1d416a0325cf3bb6498f52f0cd`. GitHub confirms both PRs are merged. The merged main tree exactly matches the approved `dd1462a` snapshot; no conflict resolution or implementation changes were needed.

## Fresh checks on merged main

- `npm test`: 2,066 tests across 157 files passed.
- `npm run build`: TypeScript and both production bundles passed. Existing chunk-size warnings remain.
- `npm audit --omit=dev`: zero advisories.
- `git diff --check`: passed; verification worktree was clean.
- Real browser localhost fixture: modern/legacy HTTP negotiation, schema validation under strict CSP, subscriptions, explicit scope authorization and OAuth discovery/DCR/PKCE/issuer/token exchange passed.
- Interactive browser fixture: city clarification submitted, durable task created and manager reconnected; delayed task write rejected after erasure; valid skill bytes accepted and tampered skill bytes rejected.

The fixture's 405 legacy-probe responses and 403 scope challenge are expected; its missing favicon also returns 405. No JavaScript exception was reported. OAuth identity is simulated, and skill integrity checks here do not replace the installed-extension approval-flow tests recorded on 14 October. This run did not repeat the full installed Chrome/local-model journey or real external-account login. The unchanged implementation tree retains that earlier [journey evidence](2026-10-14-journey-fixes.md).

The primary checkout's status and tracked diff match their pre-merge snapshots. No ChatGPT-provider/native-companion files were edited or included. The primary checkout was not pulled over its uncommitted work; merged main was built in the isolated worktree.

The preserved submitted 0.5.0 ZIP still has SHA-256 `5d2eae2b37df8e9d428b8c1447a77db2a404a47b8a7973dbc8ce6428deac7260`. No package regeneration or Chrome Web Store action occurred. The new verification record and handoff update are documentation-only follow-up changes.
