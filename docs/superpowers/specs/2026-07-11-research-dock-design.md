# Background-Research Dock & Sheet — Design

**Date:** 2026-07-11
**Status:** Approved, ready for implementation plan

## Problem

Background research tasks (`StartResearch` → offscreen agent → `researchTasks`
storage) currently render as a full `ResearchCard` pinned at the **top** of the
message list (`Chat.tsx:975`). While running it streams a truncated list of
steps; when done it swaps in the Markdown report. In practice this surface is
"very minute" — pinned above the scroll, easy to lose, and it gives no strong
signal about whether a task is still running or finished. There is also no good
story for **multiple** concurrent research tasks.

## Goal

Move live-research monitoring into a **dock directly above the composer**: a
stack of thin bars (one per active-or-just-finished task) that each expand
upward into an ~85%-height **bottom sheet** showing the live workflow. When a
task finishes, its report **drops into the chat** (appended at the end), and the
dock bar briefly shows a ✓ before auto-dismissing. The design must scale to any
number of concurrent tasks.

## Non-goals

- No change to the research **engine** (offscreen agent, `runResearch`, tools,
  storage protocol) — this is a panel-UI change only.
- Dock/sheet UI state is ephemeral React state derived from the existing
  `researchTasks` array (only `openSheetTaskId` + a `now` tick are new).

**Scoping (revised after first review):** research tasks are now **scoped to the
conversation they were launched from**, not global. `ResearchTask` gains a
`conversationId` (tagged in `StartResearch` → `research.ensureAndStart` →
`saveTask`), and the panel filters both the dock and the report cards to the
open conversation. This fixes a reported bug where a finished report stayed
pinned in *every* chat, including brand-new ones. Legacy tasks predating the
field have no `conversationId` and therefore surface in no conversation.

## Surfaces

The single `ResearchCard` (today: live steps **and** report, pinned top) splits
into three surfaces:

| Surface | Location | Responsibility |
|---|---|---|
| **`ResearchDock`** | inside `.composer-area`, directly above `.composer` | render one **`ResearchBar`** per *active-or-just-finished* task, stacked vertically. Hidden entirely when no task qualifies. |
| **`ResearchSheet`** | bottom-sheet overlay inside `.chat`, ~85% height, one at a time | live workflow log (question + full `steps` + sources-so-far) + Stop, for the task whose bar was tapped. |
| **`ResearchReportCard`** | appended at the **end** of `.messages` | the finished report or error, rendered with the same treatment as an assistant reply (see "Report card" below). |

The old top-of-list `researchTasks.map(<ResearchCard>)` block at `Chat.tsx:975`
is **removed**. The `ResearchCard` component is replaced by the three above.

## Dock lifecycle — the 15-second rule

A task qualifies for the dock when:

- `status === 'running'`, **or**
- status is terminal (`done` / `error` / `cancelled`) **and** less than 15s
  have elapsed since it finished (measured from `updatedAt`).

Per-status bar behaviour:

| Status | Bar icon | Chat card dropped? | Auto-dismiss |
|---|---|---|---|
| `running` | `⟳` spinner | — | stays until terminal |
| `done` | `✓` | **yes** — report card at end of chat | 15s after finish |
| `error` | `✕` | **yes** — error card at end of chat | 15s after finish |
| `cancelled` | `⊘` | **no** (nothing to report) | 15s after finish |

Interaction:

- Tapping a **running** bar opens its sheet (live log + Stop).
- Tapping a **done** bar scrolls the chat to that task's report card and closes
  any open sheet.
- The dock is **completely hidden** (renders `null`) when no task qualifies.

### Reopen / cold-start correctness

Dock membership is derived on each render from `researchTasks` + wall-clock time,
so:

- Reopening the panel mid-research rebuilds the dock from storage — running tasks
  reappear as `⟳` bars.
- A task that finished **while the panel was closed** has an `updatedAt` older
  than 15s, so it does **not** appear as a stale ✓ bar — only its report card
  shows at the end of chat.

### Expiry mechanism

Because dock membership depends on elapsed time (not just storage changes), a
render alone won't drop a bar 15s after completion. Approach:

- Keep a `now` tick in state, advanced by a single `setInterval` (~1s) that runs
  **only while at least one terminal-but-recent task exists**, and is cleared
  otherwise (no idle timer when the dock is empty).
- Dock membership = `tasks.filter(t => t.status === 'running' || now - t.updatedAt < 15_000)`.
- This avoids per-task timers and re-derives cleanly after reopen.

## Bottom sheet (`ResearchSheet`)

Opened for exactly one task (`openSheetTaskId: string | null` in `Chat.tsx`).
Layout, top → bottom:

- **Header:** task question + status icon + a `▼` collapse affordance. Tapping
  the header (or a scrim/backdrop) closes the sheet.
- **Workflow log:** the task's full `steps` array (not the truncated `slice(-6)`
  used today), each line prefixed by state (`✓` completed step, `⟳` current).
- **Sources so far:** `task.sources` as a simple list, updating live.
- **Footer:** `Stop` button when `status === 'running'` (calls the existing
  `cancelResearchTask(taskId)`); hidden otherwise.

Slides up from the bottom over `.messages` (~85% height) with a backdrop; only
one sheet open at a time. Closing returns focus to the dock.

## Report card (`ResearchReportCard`) — assistant-reply treatment

Appended after the last item in `.messages` for every terminal task that has a
report or error (i.e. `done` and `error`; not `cancelled`). It must match an
assistant reply's treatment:

- **Body** rendered through the existing **`AssistantText`** component (the same
  `splitBlocks` pipeline assistant replies use): image runs → `ImageCarousel`,
  standalone links → `LinkCardStack`, standalone JSON → `JsonTree`, else
  `Markdown`. This gives the report the same **image + markdown treatment**.
- **Toolbar** with the same two actions as `MessageToolbar`:
  - **Copy as image** — `copyElementAsPng(bodyRef.current)` of the rendered
    report body.
  - **Copy as Markdown** — `navigator.clipboard.writeText(task.report)`.
- **Sources** rendered through the same **`SourceBar`** used by assistant
  replies. `ResearchSource` is structurally identical to `MessageSource`
  (`{ title, url }`), so `task.sources` feeds `SourceBar` directly.
- **Error** tasks render their `task.error` in place of a report (no toolbar /
  sources needed, or a minimal error card — implementer's call).

### Shared copy actions

`MessageToolbar` currently inlines the copy-as-image / copy-as-markdown buttons
and their `idle | done | error` state. Extract those two buttons into a small
shared component — e.g. `CopyActions({ targetRef, markdown })` — reused by both
`MessageToolbar` and `ResearchReportCard` so the clipboard logic, icons, and
transient check-state live in one place. `MessageToolbar` keeps deriving its own
markdown from message parts; the report card passes `task.report`.

## State summary (all in `Chat.tsx`)

New:
- `openSheetTaskId: string | null` — which task's sheet is open.
- `now: number` tick (+ its `setInterval`) — drives 15s dock expiry.

Reused as-is:
- `researchTasks` state + the `storage.onChanged` listener (lines 258 / 365).
- `cancelResearchTask` (line 550) for the sheet's Stop button.

## Ordering of report cards

Terminal tasks with a report/error render **after** `messages.map(...)`, ordered
by `updatedAt` (oldest → newest) so the newest research report is the last thing
in the scroll — consistent with "append to the end of the chat." Only the open
conversation's tasks render (see Scoping), so a report appears at the bottom of
the chat it was launched from and nowhere else.

## Styling (`styles.css`)

New classes: `.research-dock`, `.research-bar` (+ per-status modifiers &
spinner), `.research-sheet` (+ backdrop + slide-up transition). The report card
reuses assistant-message / `research-card` styles where practical
(`SourceBar`, `Markdown`, toolbar). Respect the existing light/dark treatment
and the composer's visual language (the dock sits flush above the composer).

## Edge cases

- **Multiple concurrent tasks:** dock stacks bars; cap visible height with an
  internal scroll if the stack grows tall (implementer's call on the cap).
- **Stop from the sheet:** `cancelResearchTask` → task becomes `cancelled` →
  `⊘` bar for 15s, no chat card, sheet closes.
- **Sheet open when its task finishes:** the sheet's Stop is replaced by a close
  affordance; the report has already dropped into chat. Sheet may stay open
  showing the final log until the user closes it.
- **Timer cleanup:** the `setInterval` is cleared on unmount and whenever the
  dock empties.
```
