# Resilient background research — design

**Date:** 2026-07-20
**Status:** approved, implementing

## Problem

Background research tasks (`runResearch`, offscreen host) fail *silently* on three
edge cases, producing no result and no useful signal:

- **A — network / provider drops mid-run.** The AI SDK retries only 2× (default
  `maxRetries`, no override) over a few seconds, then `generateText`/`streamText`
  throws. In a gather round or `synthesize` that propagates → `runResearch`
  rethrows → offscreen sends `research.error` → task stuck at `status:'error'`.
  A transient blip permanently kills the task.
- **B — Chrome closed / offscreen doc evicted.** The offscreen document holds the
  only live state (an in-memory `AbortController` + the running promise). When it
  dies, no `done`/`error` is ever sent. Nothing on restart resumes research, so
  the task is frozen at `status:'running'` forever — a zombie with a spinner and
  no worker. The persisted notebook is never reused.
- **C — service worker evicted mid-run (30s idle).** Research survives in the
  offscreen doc, but the SW's in-memory browse-session maps are lost; an in-flight
  browse op spanning the eviction hits the 60s broker timeout (best-effort,
  non-fatal).

## Goal

**No runtime failure is terminal before 24h.** Every failure — network drop,
provider 5xx/429, connection-refused (local Ollama/LM Studio), 401 bad key, even
"no model configured" — puts the task into a **`paused`** state with a
human-readable reason and keeps retrying until either:

1. the **24h wall-clock cap** (`MAX_RESEARCH_DURATION_MS`), on which the task
   **finalizes a partial report** from whatever the notebook gathered, or
2. a **manual Stop** (`research.cancel` → `status:'cancelled'`).

### Non-goals

- Fast-failing on "permanent" errors (auth/model-incompatible). By explicit
  decision these also pause & retry until 24h; the visible reason lets the user
  intervene. A future classifier tweak could opt specific errors into fast-fail.
- Changing the foreground chat turn loop (`runTurnChain`). Resilience is added at
  the research phase-call granularity only, never inside shared `runAgentTurn`.

## Design

Two independent layers.

### Layer 1 — in-run resilience (fast recovery while the offscreen doc is alive)

Wrap each phase call in `runResearch` (plan / gather round / reflect / synthesize
/ verify) with `withResilience(fn, {signal, deadlineAt, onPause})`. On a
**transient** error the wrapper:

1. calls `onPause(reason, nextRetryAt)` → offscreen emits `research.paused`,
2. waits a capped exponential backoff (base 5s → cap 120s, jittered), resolving
   early on the `online` event or on `signal` abort, and never past `deadlineAt`,
3. retries the **same phase**.

Phases are idempotent against the notebook: findings are already persisted via
`Notebook.write`, and the gather prompt says "do not re-fetch what is known", so
re-running a phase is safe and near-free. Each attempt runs under a per-attempt
timeout (merged into the abort signal) so a *hung* socket becomes a retryable
timeout instead of an infinite hang.

When the wrapper gives up only because `deadlineAt` passed, it throws a sentinel
the loop treats as "finalize now".

### Layer 2 — resume watchdog (survives process death)

A `chrome.alarms` watchdog (`research-watchdog`, every 1 min) plus
`onStartup`/`onInstalled` scans `researchTasks`:

- `status ∈ {running, paused}` **and** `now − startedAt < 24h` **and** heartbeat
  stale (`now − updatedAt > STALE_MS`, 3 min) → re-dispatch `research.start` with
  `resume:true`, seeding `runResearch` from the **persisted notebook**. Covers B
  and offscreen eviction.
- `now − startedAt ≥ 24h` → re-dispatch anyway; `runResearch` sees the deadline is
  blown at entry and jumps straight to synthesize-partial → `done`.

### Double-run safety

The offscreen host ignores `research.start` when `running.has(taskId)`, so a
paused-but-sleeping task (promise still awaiting the backoff timer, so still in
`running`) is never duplicated by a watchdog tick. The guard is the correctness
mechanism; the heartbeat only keeps redundant dispatches rare. All status
transitions (`paused`/`resumed`/`done`/`error`) reuse the existing
`cur.status === 'cancelled' ? {} : …` guard so a manual Stop always wins the race.

## Changes by file

| File | Change |
|------|--------|
| `src/agent/resilience.ts` *(new, pure, tested)* | Transient-error classifier, backoff schedule, deadline-aware `wait`, and `withResilience`. No Chrome / AI-SDK imports. |
| `src/agent/resilience.test.ts` *(new)* | Classifier truth table, backoff growth + cap, wait resolves on abort/online, deadline sentinel. |
| `src/data/researchTasks.ts` | Add `'paused'` to `ResearchStatus`; add `pauseReason`, `nextRetryAt`, `deadlineAt`; new msgs `research.paused` / `research.resumed` / `research.heartbeat`; `resume`/`deadlineAt`/`notebook` seed on `research.start`; `pruneTasks` keeps `paused`; add `resumableTasks(map, now)` selector. |
| `src/data/researchTasks.test.ts` | `pruneTasks` keeps paused; `resumableTasks` selection (stale/fresh/expired/cancelled). |
| `src/agent/research.ts` | Accept `resumeNotebook`, `deadlineAt`, `onPause`; seed `createNotebook(resumeNotebook, emit)`; wrap phases in `withResilience`; deadline check in the gather loop + at entry → finalize-partial (synthesize what's gathered, mark report partial). |
| `src/background/offscreen.ts` | `running.has` double-run guard; translate `onPause` → `research.paused`/`research.resumed`; periodic `research.heartbeat`; thread `resume`/`deadlineAt`/notebook. |
| `src/background.ts` | `research-watchdog` alarm + resume scan + `onStartup` resume + finalize-on-deadline; shared `startResearchTask(taskId, {resume})`; missing provider → `paused('No model configured')` not `error`. |
| `src/ui/library/ResearchList.tsx`, `src/ui/Chat.tsx` | Render `paused` distinctly ("Waiting — <reason>, will resume automatically"); treat `paused` as active in dock/linger/cancel logic. |

## Constants

- `MAX_RESEARCH_DURATION_MS = 24 * 60 * 60 * 1000`
- Backoff: `base 5_000`, `factor 2`, `cap 120_000`, equal jitter (never 0)
- Per-attempt timeout: `900_000` — a single attempt can be a whole gather round, so
  this is large enough not to kill real work; it exists only to break a hung socket
  (the heartbeat is a blind interval and can't detect a wedged attempt).
- Finalize (best-effort synthesis at the cap) timeout: `180_000`
- Watchdog alarm period: `1` min; `STALE_MS = 180_000`; heartbeat interval `20_000`

A `ResearchDeadlineError` from **any** phase (including planning when the provider is
down from the start) is caught and finalized as a partial report — the deadline never
produces a hard error. The only terminal outcomes are `done`, partial-`done`, or a
user Stop → `cancelled`.

## Edge-case walkthrough

- **A:** phase throws transient → `paused` → backoff → `online` → retry → `running`.
- **B:** offscreen dies; task frozen. Next launch: `onStartup` + watchdog see stale
  heartbeat → re-dispatch `resume:true` → resume from notebook.
- **C:** unchanged for the offscreen loop; watchdog + heartbeat self-heal any stall.
- **24h cap:** deadline check → synthesize-partial → `done` (report tagged partial).
- **Manual Stop:** `research.cancel` → `cancelled`, wins all races.

## Testing

Unit-test the pure `resilience.ts` and the new `researchTasks` selectors. The
Chrome-coupled watchdog/offscreen wiring is verified via `/verify-extension`:
build + reload, start research, drop the network / close-and-reopen Chrome, and
confirm the task pauses then resumes rather than dying.
