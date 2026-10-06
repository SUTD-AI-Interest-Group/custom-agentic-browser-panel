# Native site actions (WebMCP)

Lychee shows a **Site actions** disclosure above the chat composer. On a supported page, it lists the native tools registered by that top-level document. The same tools enter the agent's normal `ToolSearch`/`GetTool` catalog. Ask Lychee to use a listed action; each invocation shows a one-time approval with the website origin, tool name and exact arguments.

This is separate from configured remote MCP servers. It needs no server URL, endpoint guessing, proxy, polyfill or new extension permission.

## Supported native API

The adapter follows the current `document.modelContext.getTools()` and `executeTool(registeredTool, objectArguments, { signal })` API. Both methods must exist in Chrome's **isolated content-script world**, the page must be secure and have native WebMCP enabled, and Lychee must already have scripting/site access. Chromium versions before 155 are explicitly unsupported because those experimental builds used the older JSON-string argument contract. No retry is made to probe the other signature.

WebMCP is experimental and not universally available. Lychee does not enable browser flags, enroll sites in origin trials, simulate a missing API, or request additional permissions. The UI distinguishes an unavailable API from a supported page with zero tools.

Primary references, checked 2026-10-06:

- [Chrome WebMCP overview](https://developer.chrome.com/docs/ai/webmcp)
- [Chrome imperative API: discovery, execution, cancellation and version changes](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
- [WebMCP draft specification, 2 October 2026](https://webmachinelearning.github.io/webmcp/)
- [Chrome team's extension example: isolated-world content script](https://github.com/GoogleChromeLabs/webmcp-extension/blob/main/extension/content.ts)

## Safety and scope

- Only the focused tab's top-level document is eligible. Same-origin and cross-origin iframe tools are both excluded
- Every call is pinned to Chrome's document ID, tab, exact URL, origin, tool-list revision and chat lifecycle generation. Switching tabs, navigation, reloading, hiding the chat, or permission revocation invalidates old capabilities
- Page-supplied names, descriptions, schemas, annotations and results are untrusted. Metadata is bounded; React renders descriptions as text; external schema references and prototype keys are rejected
- Claimed `readOnlyHint` or `consequentialHint` values never waive approval. Every site tool uses the existing approval queue with `once: true`
- Input-schema construction and validation run in a dedicated worker with a 1.5-second termination deadline, so recursive references or pathological regexes cannot freeze the side panel
- Both renderer and extension deadlines bound discovery/execution. Stop and page changes cancel locally immediately and request native abort on a best-effort basis
- Tool errors, null results, timeouts and navigations may occur after effects. Calls are never automatically retried
- Native registration is ultimately name-based. Revision and metadata checks reduce stale-call risk; they cannot prove a website's callback is benign or immutable. Review the origin and arguments before approving

The first version shows at most 50 top-level tools (after examining at most 200 native registrations), limits descriptions to 4,000 characters and schemas to 16,000 characters, accepts at most 32,000 characters of arguments, and returns at most 32,000 characters of site output. Schemas rejected by the metadata safety checks are omitted.

## Verification

Unit tests cover native API detection, insecure/unsupported runtimes, iframe exclusion, hostile metadata, stale document/URL/revision checks, host permissions, approval denial, Stop, renderer hangs, schema-worker termination, non-retry behavior and escaped UI rendering. A successful mocked test does not establish native browser support. Real native execution requires a browser/site exposing the current API; do not enable flags as part of routine QA.
