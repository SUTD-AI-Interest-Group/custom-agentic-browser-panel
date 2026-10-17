# Interactive MCP, durable tasks and remote skills

This is post-0.5.0 development, merged through PR #3 into the release branch, with follow-up journey fixes in PR #4. See the [development handoff](development-handoff.md) for branch and verification status. The ZIP submitted to the Chrome Web Store is unchanged. These features target modern MCP revision 2026-07-28; the legacy transport continues to work but does not advertise these new features.

## Clarification and elicitation

Modern MCP calls, resource reads and prompt retrieval can present server `elicitation/create` requests. A visible card identifies the server and lets the user review, edit, accept, decline or cancel. Forms support primitive fields and single/multiple selection enums. Responses go directly to the requesting server, not through the model or a middleware service, and are not persisted by the client. A server's eventual tool output may itself include submitted data.

URL mode displays the destination host and full URL. Only an explicit click opens an HTTPS tab; a separate Continue action resumes the original request. Opening a link does not prove the external action completed. Credentials must use URL mode; credential-like form requests and unsupported schemas are rejected. Server content remains untrusted text.

Each continuation gets a new JSON-RPC ID and echoes only that round's opaque `requestState`. Network timeouts do not expire while the user is answering. Stop/disconnect aborts pending requests. Eight rounds, sixteen requests per batch, thirty-two form fields and a fifteen-minute input timeout bound the interaction. State-only retries, sampling and roots remain unsupported; none trigger automatic tool replay.

## Durable tasks

The client advertises `io.modelcontextprotocol/tasks` and accepts task handles from negotiated `tools/call` requests. Task handles are saved in extension-origin IndexedDB before returning to the agent. The original tool request is never repeated to resume a task. If persistence fails after server task creation, the error reports the handle and warns against repeating the call.

The MCP tasks panel shows progress, offers status/result reads, explicit responses to `input_required`, and cooperative cancellation. Cancellation acknowledgement is not treated as confirmed cancellation. Terminal state is checked on the server. The model can discover `ListMcpTasks`, `GetMcpTask` and `CancelMcpTask`; each uses the approval gate. Elicitation request payloads are excluded from model task-status output.

Only handles and status metadata are persisted, not tool arguments, elicitation responses or final results. Up to 100 records are retained, reclaiming terminal/expired entries first. TTL and suggested polling intervals are respected, with a one-second minimum interval. Results are fetched from the originating server when requested and are subject to its retention policy.

Execution is durable on the MCP server. Browser-side polling runs while the visible chat panel is mounted and resumes when it reopens. It is not an always-running service worker or a client job runner. There is no third-party middleware. A closed browser does not prevent the MCP server from continuing its own work.

Handles bind to the server URL, configured headers and OAuth grant session. The local session identifier survives refresh-token rotation but is revoked by sign-out, token invalidation or an issuer change. A different endpoint/account cannot inherit the handle. Same-origin unauthenticated servers are bound to their configured endpoint and headers. Task notifications are not used in this implementation; polling is the recovery mechanism.

## Skills over MCP

The model can discover `ListMcpSkills`, `ReadMcpSkill` and `ReadMcpSkillFile`. Discovery requires the server to advertise Resources and `io.modelcontextprotocol/skills`. Direct loading by URI also works for unlisted skills.

Loading first obtains metadata with approval, then asks for fresh activation approval bound to the returned manifest. The retained entry is scoped to the originating connection and current tool session, never registered as an ordinary local filesystem skill. Supporting files load only on demand. Relative references resolve from the skill root and must identify an exact manifest entry on the same server. Files from another server require a separate skill load and approval.

Every read verifies raw UTF-8/base64 bytes against byte size and SHA-256, and `SKILL.md` YAML frontmatter against all advertised fields. Aliases and duplicate YAML keys are rejected. Changed bytes/metadata fail closed; the user must load and approve the refreshed skill. Content is not prefetched or stored in a disk cache. A nested SKILL.md read is supporting content, not activation; nested activation requires separate approval. `allowed-tools` or other frontmatter does not grant execution or tool permissions.

Manifests support up to 512 files and 16 MiB total. This implementation exposes UTF-8 text instructions/supporting files; non-UTF-8 binary content is rejected. Dynamic skills are deliberately declined because they have no stable integrity manifest. Optional directory listing is not implemented; the retained manifest lists supporting files.

## Verification

Unit/integration coverage includes MRTR state isolation, fresh IDs, cancellation, unsupported inputs, safe URLs, form validation, task persistence/reconnect without tool replay, TTL, credential scope changes, cooperative cancellation, explicit task input, skill byte/digest/frontmatter mismatches, manifest boundaries, undeclared capabilities and approval-denial paths.

`node scripts/mcp-browser-smoke.mjs` serves a local-only fixture. Its real browser UI exercises forms, durable tasks surviving a page reload, task input/completion, verified skill reads and tampered-content rejection under CSP without unsafe-eval. Chrome identity/storage are fixture shims; actual network fetch, Web Crypto and IndexedDB run in the browser. No external account is required and this is not live third-party interoperability certification.

Initial feature verification on 2026-10-14: 2,040 tests across 154 files pass; TypeScript and both production builds pass; npm audit reports zero advisories. Browser form continuation, task persistence across a full page reload, explicit task input, final output, verified skill reading and tampered-byte rejection pass. The final polling check no longer reports an operation conflict while the user answers.

The 0.5.0 submitted ZIP retains SHA-256 `5d2eae2b37df8e9d428b8c1447a77db2a404a47b8a7973dbc8ce6428deac7260`.

The later security and journey fixes pass **2,066 tests across 157 files**; see the [final journey verification](verification/2026-10-14-journey-fixes.md) for the installed-browser scenarios and evidence limits.

## Sources

- https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
- https://github.com/modelcontextprotocol/ext-tasks/blob/main/schema/2026-07-28/schema.ts
- https://modelcontextprotocol.io/extensions/skills/overview
