# Background Work and Cleanup

Once chats, research and services can keep working after the panel closes, every
one of them needs a clear end. I wanted to account for what each job holds, who
owns it, and what releases it on completion, Stop, failure or disconnection.

This is the cleanup follow-up to [Simplifying Lychee](Simplifying-Lychee), included
in [`9180e33`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/commit/9180e33bb35e1cf688a8861443307aacbe6e7b8d)
on 11 November 2026. It is pushed on `codex/optimisation-background-cleanup` and
unmerged at the time of writing.

## Saved work and live work have different lifetimes

A conversation, research report or resumable task record should remain available
after its job ends. Its network request, timer, browser tab, worker and tool
connection should not remain alive just because the record exists.

Closing the panel also has a different meaning from pressing Stop. A live
background chat must keep going when its UI disappears. Reopening the panel
reattaches to that run. Stop cancels it. Cleanup has to preserve that distinction,
otherwise a resource-saving change quietly breaks the reason background work
exists.

## One shared host needs one lifecycle

The offscreen document hosts four kinds of work: chat, research, memory
consolidation and DOM processing. Checking only chat and research could close the
document while a memory call was still running. Treating a saved task as proof of
activity could keep it open indefinitely.

The host now counts its live tenants. Once idle for two seconds, it reports that
state to the service worker. Creation, dispatch and closure all use one serial
queue. Before closing, the worker asks the host for its current status inside
that queue.

That closes the gap between “it looked idle” and “new work just started.” Unknown
or unresponsive status does not authorize closure. Deferred idle closure is
retried, and even an empty host whose first dispatch failed reports itself idle.

The implementation is small enough to read directly:
[`offscreenLifecycle.ts`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/9180e33bb35e1cf688a8861443307aacbe6e7b8d/src/background/offscreenLifecycle.ts).
It owns the lifecycle, rather than leaving every caller to coordinate its own
check-and-close sequence.

## Cancellation has to reach the thing doing the work

Marking a research task cancelled is only the stored outcome. The model request,
broker wait and browser work still need to receive the cancellation.

The task's abort signal now clears its heartbeat immediately, even if an
underlying promise never settles. Broker calls remove their timers and listeners
on result, timeout or abort. An already-aborted task cannot enqueue another call.
Task-scoped controllers also cancel queued render/search requests and navigation
waits.

Waiting for a browser-tab lease was a particularly awkward boundary. A task could
be cancelled while waiting, then acquire the lease later and retain a tab nobody
was expecting. Lease acquisition is now abortable while preserving queue order.
Closing a browse session also cancels an opening still in progress.

Clearing research now cancels active work and releases its resources **before**
deleting the records. Late requests for inactive or deleted tasks are refused.
Clearing the list should not leave an invisible model call running behind it.

## Release the whole conversation chain

A chat run owns heartbeat and stream-flush timers, tool calls and its running-map
entry. Those leave through `finally` on success, error or cancellation. Background
MCP clients disconnect when their last tool runtime and pending call are gone.

Page-control sessions have a longer lifetime: they belong to the continuation
chain, so an automatic continuation can keep using the same session. Chain exits
release the worker session and page overlays. A parked session can remain while
its panel is present; disconnecting that panel releases parked sessions while
preserving live background runs.

Release is also tied to the run's chain identity. A delayed cleanup message from
an old run cannot tear down a newer chain. “Always clean up” still needs to answer
“clean up whose resources?”

## Give reusable engines an idle boundary

| Resource | Release rule |
| --- | --- |
| PDF extraction and Office parsing workers | Terminate after 30 seconds without use; recreate on the next request |
| PDF rendering cache | Destroy unused pdf.js tasks and release source bytes after 30 seconds, even below the three-entry cap; protect entries still in use |
| Code sandbox | Remove its iframe, message listener and engine after 30 seconds idle; recreate when needed |
| Research browser sessions | Release on task completion or cancellation; close unused research windows when no lease remains |
| Page-watch tabs | Close after each check, including failure; a tab activated by the user transfers to the user |
| Background MCP task clients | Close in `finally`, including failed checks |
| ChatGPT companion calls | Existing port cleanup removes timeout/abort listeners; transport closure aborts work and lets the host process exit |

A cache's capacity limit alone does not give it an end. Three cached PDFs can
still hold their bytes and rendering workers for the rest of a session. Reference
counts protect active readers; idle eviction handles entries no reader needs.

Page-watch cleanup also covers failure to save ownership. If an inactive tab was
created but its ownership record could not be stored, that tab is closed there
and then. Existing orphan sweeps and browse-session deadlines remain as recovery
paths for interrupted contexts.

Research, MCP-task and page-watch queues now disarm their minute alarms when
empty. New records and startup re-arm them. Ordinary updates leave an existing
alarm in place so frequent writes cannot keep postponing it. The user's configured
memory-consolidation schedule remains intentional background work.

## Test resources, as well as status labels

The final extension suite passed **2,069 tests across 170 files**, with TypeScript
and production builds passing too. The companion's separate suite passed 12
tests. Focused regressions cover host-close races, memory and DOM tenants,
cancelled heartbeats, queued tab leases, worker/cache destruction, sandbox
recreation, parked sessions and failed tab-ownership writes.

The real-Chrome fixture held two research model calls open. Cancelling one had to
leave the other running. Clearing the remaining research had to abort its model
socket, remove its records, close the idle host and disarm the empty queue's
alarm. Separate fixtures checked completed and cancelled chats, tools after panel
closure, MCP completion/reconnection and page-watch tab cleanup.

That is stronger evidence than seeing “Cancelled” in the UI. The browser checks
observe the resources that should have been released. Commands and the ownership
inventory are in the
[lifecycle record](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/9180e33bb35e1cf688a8861443307aacbe6e7b8d/docs/background-lifecycle.md).

Chrome still controls process reuse and garbage collection. Releasing a worker
or iframe does not promise an immediate matching drop in OS memory. Long-duration
heap and battery profiling, real provider traffic and real OAuth accounts were
outside these local fixtures. The work establishes explicit release paths and
checks their behaviour; those measurements remain separate work.
