# Background resource lifecycle

Cleanup follow-up, 11 November 2026. This audit covers active resource ownership separately from saved conversations, reports and resumable task records, which intentionally remain available.

| Resource | Owner | Release behaviour |
| --- | --- | --- |
| Offscreen document | Shared chat, research, memory and DOM hosts | Counts all four tenants. Reports idle after two seconds and retries if closure was deferred. A live status check and closure are serialized against creation/dispatch. An empty host also reports idle if its initial dispatch failed. |
| Chat generation | Offscreen chat actor | Clears heartbeat/flush timers and the running entry in `finally`; releases tool runtimes on completion, cancellation or error. Closed-panel inference remains active until it actually settles. |
| Tool execution and approvals | Service-worker tool host | Abort controllers stop pending work; durable approval mailboxes unsubscribe in `finally`. Stop and interrupted-host recovery explicitly release the tool runtime. |
| Page-control sessions | Conversation continuation chain | Chain completion releases the worker session and page overlays, including budget/checkpoint exits. A parked session can survive while its panel is present; disconnecting that panel releases parked sessions while preserving live background runs. Late release of an old run cannot tear down a newer chain. |
| Background MCP clients | Tool runtimes / task monitor | Tool clients disconnect after the last runtime and pending call are released. Task-monitor clients close in `finally` on success or failure. Retry timers are cleared by manager teardown. |
| Research model calls and brokers | Offscreen task AbortController | Cancel aborts network work and clears its heartbeat immediately, including when the underlying promise does not settle. Broker timers/listeners are cleared on result, timeout or abort. Already-aborted tasks do not enqueue new broker calls. |
| Research browser work | Task-scoped request controllers and tab leases | Cancellation stops queued render/search work and navigation waits. A cancelled browse opening cannot acquire and retain a lease later. Task completion/cancellation releases sessions; unused research windows close immediately when no lease remains. Existing orphan sweeps, the four-minute browse-session TTL and the idle janitor remain crash-recovery fallbacks. |
| Clearing research | Service worker | Cancels active tasks and releases their resources before deleting records. Clearing saved tasks can no longer leave invisible model work running. Late browser requests for inactive/deleted tasks are refused. |
| PDF extraction / Office parsing | FIFO worker clients | Workers terminate after 30 seconds without use; the next call recreates them. Dead workers reject pending calls rather than holding them until a later timeout. |
| PDF rendering cache | Reference-counted PDF cache | Releases source bytes and destroys pdf.js rendering tasks after 30 seconds of inactivity, even below the three-entry size cap. In-use entries are never destroyed; capacity is rechecked when a caller releases an entry. |
| Code sandbox | FIFO execution host | Removes its iframe, message listener and engine after 30 seconds without use. Recreates it for a later call. Closing an idle offscreen host releases it sooner. |
| Page-watch tabs | Watch ownership record | Close after each check, including error/cancellation, without closing tabs taken over by the user. If recording ownership fails, the newly-created inactive tab is still closed. Orphan cleanup survives worker restart. |
| Task monitor alarms | Persisted research/MCP/watch queues | Empty queues disarm their minute alarms. New records and startup re-arm the monitors; existing alarms are not postponed by ordinary updates. The configured memory-consolidation schedule remains intentional. |
| ChatGPT native companion | Native messaging call | Existing cleanup disconnects its port and clears timeout/abort listeners. Companion stdin/stdout closure aborts the request and exits the process. Real account inference was not exercised. |

## Verification

- Full extension suite: 2,069 tests across 170 files.
- Production build and TypeScript checks pass.
- Regression tests cover creation/dispatch/close races, busy DOM and memory tenants, cancelled research heartbeats, cancellation while waiting for a tab lease, PDF cache/worker destruction and recreation, sandbox recreation, MCP disconnect, parked-session cleanup and temporary-tab ownership failure.
- Real Chrome checks cover completed and cancelled chat host shutdown, closed-panel reconnection, code/PDF tool completion and host shutdown, concurrent research cancellation, clearing active research, aborted model sockets, empty alarm queues, MCP completion/reconnect and page-watch tab cleanup.

Browser reproduction after `npm run build`, with `CHROME_BIN` pointing at Chrome for Testing:

```sh
node scripts/test-closed-panel-chat-browser.mjs
node scripts/test-background-tools-browser.mjs
node scripts/test-background-cleanup-browser.mjs
node scripts/test-mcp-tasks-browser.mjs
node scripts/test-page-watches-browser.mjs
```

Checks establish that the extension releases the owners of resources. Chrome controls process reuse and garbage collection, so a closed worker or iframe does not imply that the OS immediately shows the same reduction in resident memory. Long-duration heap/battery profiling and real provider/OAuth traffic remain outside these local fixtures.
