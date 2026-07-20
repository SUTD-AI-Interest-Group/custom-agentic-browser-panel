# Agent Steering — Design

**Date:** 2026-07-20
**Status:** Approved, implementing
**Branch:** `worktree-agent-steering`

## Goal

Let the user inject a follow-up message *while the agent is mid-task* to steer the
running turn — redirect focus, add a constraint, correct course — without stopping
and restarting. The steer is absorbed by the in-progress continuation chain and
takes effect at the next action the model takes.

## Decisions

- **Timing — next step boundary.** A steer is applied after the model's current step
  (model call + any tool execution) completes, before its next action. Never
  mid-token, never mid-tool-execution. During page control this means a steer lands
  *before the next action*, never interrupting a click already in flight — a
  desirable guardrail. If the running turn finishes before any boundary is reached
  (e.g. a one-shot text answer), the pending steer simply becomes the next cycle, so
  it is never lost — same mechanism, no special case.
- **UX — dedicated steer bar.** A slim bar rendered above the composer, visible only
  while the agent is working. Stop stays on the composer.
- **Transcript — normal user bubble.** The steer renders as an ordinary user message
  bubble, inline at the point it landed (between the assistant's pre-steer and
  post-steer bubbles).
- **Scope — foreground chat only** (`runTurnChain`), including page-control
  sequences. Background research (offscreen host, no user present) is out of scope.
- **Payload — text + attachments.** A steer reuses the composer's message assembly,
  so it can carry a captured screenshot and page context in addition to text. The
  steer bar surfaces a compact camera affordance and the shared attachment tray;
  full `@mention` parity is a stretch handled by the same assembly path.

## Approach (chosen: A — steer ends the cycle, a new cycle picks it up)

`runTurnChain` (`src/ui/Chat.tsx`) already drives `runAgentTurn` as a *continuation
chain*: each cycle is a fresh `runAgentTurn` reading `historyRef`, streaming into its
own assistant bubble, and the chain loops while the model checkpoints / hits its step
budget. Steering plugs into this existing machinery.

1. **Enqueue.** Submitting the steer bar builds a normal user message (via the shared
   assembly), optimistically appends its UI bubble, and pushes the model-facing
   message onto a `steerQueueRef` (a mutable array shared by reference, exactly like
   `imageQueue`).
2. **Halt at the boundary.** `runAgentTurn` gains one optional option,
   `steerPending?: () => boolean`, appended as a third OR-condition to its existing
   `stopWhen` (`isStepCount(maxSteps)`, `hasToolCall(Checkpoint)`). When a steer is
   pending, the loop halts after the current step. The in-flight step's assistant/tool
   messages are already in `responseMessages`, so no tool call is orphaned. The
   predicate only *reads* the queue; it never drains it.
3. **Drain + continue.** After each cycle, `runTurnChain` checks the queue: if
   non-empty, it splices the steers out, pushes them into `historyRef` as user
   messages, opens a fresh assistant bubble, and continues the chain. This path is
   **not** counted against `MAX_AUTO_CONTINUES` (it is user-driven) and gets a fresh
   step budget, like a continuation. Only when the queue is empty do the existing
   `completed` / `checkpoint` / `budget` rules decide whether to stop.

### Why A over B (mid-cycle `prepareStep` injection)

Injecting the steer into the *same* cycle via `prepareStep` (the `imageQueue` channel)
was rejected: the injected user message is not part of `responseMessages`, so
persisting it means tail-appending out of order; rendering it as an inline *user
bubble* would require splitting one streaming assistant bubble mid-cycle (the
architecture only creates new bubbles at cycle boundaries); and composing
text+image+tab-sync duplicates `send()`. Approach A reuses two systems already in
place — the continuation chain and `send()`'s message assembly — and yields correct
history ordering for free:

```
[…, user "do X", assistant/tool work-so-far, user "steer Y", assistant/tool continuation]
```

Because a *user* message may carry an image file-part (only tool *results* may not,
per the imageQueue invariant), attachments ride along the ordinary history path with
no imageQueue involvement.

## Components

- **`src/agent/agent.ts`** — add `steerPending?: () => boolean` to `runAgentTurn`
  options; append to `stopWhen`. Only change to the agent core. Locked by a new test
  in `agent.test.ts`.
- **`src/ui/Chat.tsx`**
  - Extract the user-message assembly tail of `send()` into a shared async helper
    (resolve mentions/`@all`/deictic tab/selection/`@memory`/images → `modelText`,
    the `ModelMessage`, `attachedSources`, journal note). `send()` and `steer()` both
    call it.
  - `steerQueueRef: { message: ModelMessage; sources: MessageSource[]; journal: string; useMemory: boolean }[]`.
  - `steer()` — assemble, add the UI bubble, enqueue. Guarded to run only while
    `streaming`.
  - `runTurnChain` — pass `steerPending: () => steerQueueRef.current.length > 0` into
    `runAgentTurn`; after each cycle drain the queue (push to `historyRef`, new
    assistant bubble carrying the steer's sources, seed `activeNames`/`turnAllowed`
    with `SearchMemory` if a steer used `@memory`), then continue. Include steer text
    in the episode journal.
  - `stop()` and the chain's outer `finally` clear `steerQueueRef`.
  - Steer-bar state (`steerInput`, steer attachment tray) and render.
- **`src/ui/styles.css`** — steer-bar styling: accent-tinted, theme-aware
  (light/dark), slim, sits above `.composer`.

## Edge cases

- **Stop during a pending steer** — `stop()` aborts the chain and clears the queue;
  queued steers are discarded (the user asked to stop).
- **Approval card open** — the steer bar still accepts input; the steer queues and is
  applied once the pending step resolves (approve/deny) and the cycle reaches its
  boundary. Coherent: a steer can't jump an approval gate.
- **Multiple steers before a boundary** — all queued steers drain in order into
  history as sequential user messages.
- **Continue card (paused at the auto-continue ceiling)** — `streaming` is false, so
  the steer bar is hidden; the user types in the normal composer, which starts a turn
  that continues from the checkpoint anyway.

## Verification

- `npm run build` (tsc + vite) and `npm test` green, including the new
  `steerPending` test.
- Manual (via `/verify-extension`): during a multi-step turn (e.g. page control or a
  research-free tool sequence), open the steer bar, inject a redirect, confirm the
  model adjusts at its next step, the steer shows as a user bubble, and history/reload
  are consistent.
