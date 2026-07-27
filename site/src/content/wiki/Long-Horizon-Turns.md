# Long-Horizon Turns

**The problem**, stated in the spec: hitting the step ceiling was *a silent stop*.

> The partial progress renders and the user must manually type "continue". That
> blind continue restarts with no sense of where it was — re-trying dead-ends it
> had already hit (404-wandering).

The model would burn its second budget rediscovering that the third link was
broken, because nothing carried forward *what it had already learned not to do*.

Spec: [`2026-07-11-long-horizon-tasks-design.md`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/docs/superpowers/specs/2026-07-11-long-horizon-tasks-design.md).

---

## Checkpoint: make exhaustion a first-class event

Three steps before the ceiling, `prepareStep` nudges the model to stop starting
new work and call **`Checkpoint`** — an ungated control tool whose input schema
*is* the hand-off:

```ts
Checkpoint({ done, remaining, avoid, nextAction })
```

`avoid` is the field that earns its keep. It carries the dead ends forward, which
is the entire difference between resuming and restarting.

Two design choices worth naming:

- **A dedicated tool, not text-parsing.** We could have watched for the model
  saying "I'm running out of steps." Instead, detection is an *explicit signal*,
  the payload rides in history for the continuation to re-read, and it doubles as
  the content of the Continue card the user sees. One mechanism, three jobs.
- **`Checkpoint` is ungated**, one of only three tools in the codebase that are.
  It touches no page, no network, no data — its only job is to end a turn
  cleanly. The human gate for *resuming* is the Continue card itself.

## One budget to rule them all

Before this, there were three:

| Budget | Behaviour on exhaustion |
| --- | --- |
| `MAX_STEPS = 24` | silent stop |
| `MAX_SESSION_ACTIONS = 20` (page control) | returned a note |
| research's "≤8 searches" | a soft prompt hint |

Three budgets, three exhaustion semantics, and no way to reason about "how much
work can this turn do." `e078f3c` collapsed them: **one 24-step budget bounds all
activity, page control included.** The per-session action budget was deleted
outright.

Once exhaustion was *detectable* rather than silent, the second budget stopped
earning its complexity.

## The continuation chain

`runTurnChain` loops `runAgentTurn`, auto-continuing up to `MAX_AUTO_CONTINUES = 3`
with a fresh step budget each cycle, then surfacing the Continue card. The
page-control session and the on-page overlay **survive** these auto-continues —
which is why teardown lives in the chain's **outer** `finally` and not inside a
single turn.

The invariant that matters most here, restated in the design doc, in CLAUDE.md,
and in the commit body — three places, because we expect a future refactor to try
to break it:

> **Auto-continue grants more *steps*. It never bypasses a risky-action gate.**
> Point-of-no-return actions still confirm individually, every cycle, every time.

A system that quietly gets *more permissive* the longer it runs is the exact
failure mode people fear from agents. The budget refreshes; the consent does not.

## Steering a turn without stopping it

The continuation chain buys one more thing, added on 20 July
([`2026-07-20-agent-steering-design.md`](https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/blob/main/docs/superpowers/specs/2026-07-20-agent-steering-design.md)):
letting the user **redirect a running turn** — add a constraint, correct course —
without hitting Stop and starting over.

The tempting design was to inject the steer into the *current* step, through the
same `imageQueue` channel that feeds images mid-cycle. `9876c52` rejected that and
reused the chain instead, because the chain already does the hard part:

- **Enqueue, don't interrupt.** A composer submit while the agent is streaming is
  *not* a new turn — `steer()` assembles it exactly like any user message and pushes
  it onto `steerQueueRef`. The queue holds *promises*, so the pending flag flips true
  the instant you submit, even while the steer is still resolving its attached tab —
  a steer that is still assembling can't be missed at a cycle boundary.
- **Halt at the boundary, never mid-action.** `runAgentTurn` gained exactly one
  option, `steerPending?: () => boolean`, OR'd into its existing `stopWhen` beside
  the step ceiling and `Checkpoint`. The loop stops after the *current* step finishes
  — never mid-token, never mid-tool, and during page control never mid-click. A steer
  physically cannot jump an open approval card; it lands the moment the pending step
  resolves.
- **Drain into history as a real user turn.** After each cycle, `runTurnChain`
  splices the queued steers into history as ordinary user bubbles, opens a fresh
  assistant bubble beneath, and continues — on a fresh step budget that is **not**
  charged against `MAX_AUTO_CONTINUES`, because the user drove it. History comes out
  correctly ordered for free: `[…, "do X", work-so-far, "actually, Y", continuation]`.

Two properties fall out of reusing the chain rather than fighting it. A steer can
carry a screenshot or page context, and those ride the *ordinary user-history path*
— a user message may hold an image part where a tool result may not (the
[imageQueue invariant](Agent-Perception#the-dead-letter-box)), so no new plumbing is
needed. And Stop stays unambiguous: `stop()` clears the queue, so pending steers are
*discarded* — you asked to stop, not to redirect. The `steerPending` stop-condition
is pinned by a regression test in `agent.test.ts`, because a feature that silently
stops working is this project's recurring nightmare — which is exactly the next
section.

## The bug that made the whole thing inert

Told in full in [The Agent Turn Loop](The-Agent-Turn-Loop#2-finishreason-doesnt-say-what-the-docs-imply):
we shipped auto-continue and it never once auto-continued, because the AI SDK
reports `finishReason: 'other'` — not `'tool-calls'` — when `stopWhen` halts the
loop. Every truncated turn was mislabelled `'completed'`, and the chain broke out
instead of continuing.

The feature was *entirely* inert for a day, and nothing errored. It just quietly
behaved like the old silent stop it was built to replace. **A feature with no
failing test and no visible error can be 100% broken and look 100% fine.**

## Headless variant

Background research reuses the identical core with two differences: a higher
ceiling (`RESEARCH_MAX_AUTO_CONTINUES = 5`), and a final-cycle override that tells
the model *"write the report now — do not Checkpoint."*

There is no human to show a Continue card to, so the last cycle must produce an
answer rather than a hand-off. A checkpoint nobody can resume is just a dropped
task.
