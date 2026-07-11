# Long-horizon task management — design

**Date:** 2026-07-11
**Status:** implemented (branch `worktree-long-horizon-tasks`)

## Problem

A single agent turn is bounded by `stopWhen: stepCountIs(24)` in `runAgentTurn`
(`src/agent/agent.ts`). When a long task (e.g. scraping 9 product pages) exhausts
the 24-step budget, `streamText` simply stops: the partial progress renders and
the user must manually type "continue". That blind continue restarts with no
sense of where it was — re-trying dead-ends it had already hit (404-wandering).

Three separate, inconsistent budgets existed: `MAX_STEPS = 24` (silent stop),
`MAX_SESSION_ACTIONS = 20` (page-control, returned a note), and the research
agent's soft "≤8 searches" prompt hint. The background research agent
(`src/agent/research.ts`) reused the same 24-step `runAgentTurn`, so it could
silently truncate its report too.

## Goals

1. Make budget exhaustion a **first-class, detectable event**, not a silent stop.
2. Near the ceiling, nudge the model to **checkpoint** a structured hand-off
   (what's done, what's left, wrong paths to avoid, the next action) instead of
   getting cut off mid-action.
3. **Auto-continue** a small number of times seamlessly, then surface a
   **Continue card** that resumes with a fresh budget.
4. Apply the same core to the headless research agent (auto-continue to a higher
   cap, then force a final report — no user to prompt).
5. Collapse the budgets: **one 24-step budget bounds all activity**; remove
   `MAX_SESSION_ACTIONS`.

## Decisions

- **Continuation policy:** auto-continue up to `MAX_AUTO_CONTINUES = 3`, then ask
  (foreground). Auto-continue grants more *steps*; point-of-no-return page
  actions still confirm individually, so it never bypasses a risky-action gate.
- **Checkpoint mechanism (Approach A):** a dedicated ungated `Checkpoint` tool.
  Its input schema *is* the reflection payload, so detection is an explicit
  signal (not text-parsing), the hand-off rides in history for the continuation
  to re-read, and it doubles as the Continue card's content.
- **Scope:** shared core, applied to both the foreground chat and the headless
  research agent.

## Architecture

### Shared core — `src/agent/agent.ts`

- `stopWhen: [stepCountIs(24), hasToolCall('Checkpoint')]` (OR semantics).
- An ungated `Checkpoint` tool is injected into every turn's toolset inside
  `runAgentTurn` (never in `createAgentTools`, so it never appears in the
  tool-permission UI). It is exempt from `requestApproval` — a pure control
  signal touching no page/network/data; the human gate is the Continue card.
- `prepareStep` (which already drains the screenshot `imageQueue`) also injects a
  one-per-turn wrap-up nudge once `stepNumber >= MAX_STEPS - NUDGE_LEAD`
  (`NUDGE_LEAD = 3`, i.e. step 21). The nudge text is overridable per call via
  `wrapUpNudge` (`''` disables it).
- New return field `stop: { reason, checkpoint?, stepsUsed }` where
  `reason: 'completed' | 'checkpoint' | 'budget'`:
  - `checkpoint` — the model called `Checkpoint` (captured from the tool-call).
  - `budget` — hit the ceiling mid-tool-call (`stepsUsed >= MAX_STEPS &&
    finishReason === 'tool-calls'`): a cut-off, no reflection.
  - `completed` — natural finish.
  Aborts (Stop) and provider errors are thrown out of the stream and
  distinguished by the caller's `catch`, so they are not `stop.reason` values.

`Checkpoint` fields: `done[]`, `remaining[]`, `avoid[]`, `nextAction`.

### Foreground continuation — `src/ui/Chat.tsx`

`send()`'s inline single-turn execution is extracted into `runTurnChain()`, a
loop around `runAgentTurn`:

- On `completed` → stop. On `checkpoint`/`budget` → if `autoContinuesRef <
  MAX_AUTO_CONTINUES`, loop immediately (fresh budget); else set `continuation`
  state → render the **Continue card**.
- **Teardown (`pageControl.endSession()` + `unmountAllPresence()`) lives in the
  outer `finally`**, so the page-control session and on-page presence overlay
  **survive auto-continues** and are torn down only when the whole chain ends
  (completion, abort, error, or the ask-boundary).
- Transcript treatment is behind `MERGE_AUTO_CONTINUES` (default `false`): a new
  assistant bubble per cycle with a "↻ Continued automatically" divider
  (`UIMessage.autoContinue`). `true` appends all cycles into one bubble.
- `continueTask()` (Continue-card click) resets the auto-continue quota and runs
  a fresh chain from history — the `Checkpoint` hand-off is already in history,
  so no synthetic user message is needed. It re-requests page control if needed
  (a new session gate — consistent with "auto-continue never bypasses grants").
- Continuation state is **ephemeral**; the checkpoint itself rides in the
  message history, so it survives a panel reload (the user can still type
  "continue").

### Headless research — `src/agent/research.ts`

`runResearch` loops `runAgentTurn`, accumulating history across cycles. It
auto-continues up to `RESEARCH_MAX_AUTO_CONTINUES = 5` on `checkpoint`/`budget`;
on the final cycle it passes a `FINAL_CYCLE_NUDGE` ("stop searching and write the
report now; do not Checkpoint") so it always ends with a synthesized report.

### Budget removal

`MAX_SESSION_ACTIONS`, `ControlSession.actionsUsed`/`maxActions`, the
`ControlPage`/`AutofillForm` budget checks and `actionsLeft` fields are removed.
The 24-step turn budget is now the single bound on all agent activity.

## Error / edge matrix

| Stop | Auto-continues left | Behavior |
|---|---|---|
| `completed` | — | Chain ends, teardown |
| `checkpoint`/`budget` | yes | Seamless auto-continue (session + presence survive) |
| `checkpoint`/`budget` | no | Foreground → Continue card; research → return partial |
| aborted (Stop) | — | Break; drop a dangling trailing user message only if no cycle completed; teardown; no card |
| error | — | Error bubble; same history rule; teardown; no card |

## Constants

```
MAX_STEPS = 24                    // agent.ts — single budget for all activity
NUDGE_LEAD = 3                    // agent.ts — nudge at step 21
MAX_AUTO_CONTINUES = 3            // Chat.tsx — foreground cycles before the card
RESEARCH_MAX_AUTO_CONTINUES = 5   // research.ts — headless cycles before partial
MERGE_AUTO_CONTINUES = false      // Chat.tsx — transcript treatment (swap flag)
// removed: MAX_SESSION_ACTIONS
```

## Verification

No test suite (per `CLAUDE.md`): `npm run build`, reload the unpacked extension,
exercise via `/verify-extension`. To trigger the flow quickly without a huge
task, temporarily lower `MAX_STEPS` (e.g. to 4) and confirm: nudge → `Checkpoint`
→ auto-continue ×3 → Continue card showing the reflection → resume; and that a
point-of-no-return still confirms during an auto-continue.
