/** Persisted research-task state + the SW↔offscreen↔panel message protocol. Runs in SW/panel only (never offscreen). */
import type { ObservabilityConfig, ProviderConfig } from './settings'
import type { ResearchNotebook } from '../agent/notebook'
import type { BrowseAction } from '../tools/browsePolicy'
import { estimateBytes, type StoreUsage } from './usage'

/**
 * `paused` is a resilient waiting state: the task hit a transient failure (network
 * down, provider 5xx/429/auth, hung request) and is backing off to retry. It is
 * *active* — treated like `running` for pruning, cancellation, and the dock — never
 * a terminal state. A task only leaves the active set at the 24h cap (→ `done` with
 * a partial report, or `error`) or a manual Stop (→ `cancelled`).
 */
export type ResearchStatus = 'running' | 'paused' | 'done' | 'error' | 'cancelled'

/** A task is `running` or `paused` — i.e. still owned by a (possibly dead) worker. */
export function isActiveStatus(status: ResearchStatus): boolean {
  return status === 'running' || status === 'paused'
}

/** The hard wall-clock cap on a research task: 24h from `startedAt`. The ONLY
 *  timeout, alongside a manual Stop. */
export const MAX_RESEARCH_DURATION_MS = 24 * 60 * 60 * 1000

/** How long without a heartbeat before the watchdog treats a task's worker as dead
 *  and re-dispatches it. Comfortably larger than the offscreen heartbeat interval
 *  and the 1-min watchdog period, so a live-but-quiet task is never double-run. */
export const STALE_MS = 3 * 60 * 1000

export interface ResearchSource { title: string; url: string }

/**
 * What produced a step. The log is not only tool calls: the model's own text
 * between calls is its reasoning, and dropping it (as the log used to) left the
 * sheet showing a wall of anonymous searches with no visible thinking.
 */
export type ResearchStepKind = 'tool' | 'thought' | 'phase'

/** One entry in a research run's live log: a collapsed one-liner plus expandable
 *  detail (bounded input + result) so the sheet can show what was fetched. */
export interface ResearchStep {
  /** Tool that ran, e.g. 'WebSearch' | 'FetchUrl' — or the phase/thought label. */
  tool: string
  /** Collapsed one-liner shown in the log (tool + short input preview). */
  summary: string
  /** Expanded detail: bounded, pretty-printed input + result. */
  detail: string
  status: 'running' | 'done' | 'error'
  /** Defaults to 'tool' when absent (legacy tasks predate this field). */
  kind?: ResearchStepKind
  /** Indent level: 0 = the research agent, 1 = a nested BrowseSite sub-agent. */
  depth?: number
}

// ---------------------------------------------------------------------------
// Interactive browse protocol (offscreen sub-agent → SW → the isolated tab).
// The offscreen host cannot touch tabs, so every step of a browse session is a
// round-trip. See src/platform/researchBrowse.ts for the SW side.
// ---------------------------------------------------------------------------

/** One step the browse sub-agent asks the SW to take in the research tab. */
export type BrowseOp =
  | { kind: 'open'; url: string }
  | { kind: 'act'; action: BrowseAction }
  | { kind: 'read' }
  | { kind: 'close' }

/** What the sub-agent sees after a step: where it is, and what it can act on. */
export interface BrowseObservation {
  url: string
  title: string
  /** The numbered interactive elements, in the compact form the model reads. */
  elements: string
  /** The head of the page's readable text — `read` returns the whole thing. */
  excerpt: string
  /** True when the page has more text than the excerpt shows. */
  more: boolean
}

export interface BrowseResult {
  ok: boolean
  /** Human/model-readable outcome — on refusal, WHY the policy said no. */
  message: string
  observation?: BrowseObservation
  /** Full readable text, for a `read` op. */
  text?: string
  url?: string
  title?: string
  error?: string
}

export interface ResearchTask {
  id: string
  question: string
  status: ResearchStatus
  steps: ResearchStep[]
  report?: string
  sources?: ResearchSource[]
  error?: string
  startedAt: number
  updatedAt: number
  /** The conversation this research was launched from, so its dock bar and
   *  report card only surface in that chat (legacy tasks lack it and, being
   *  unmatched, surface in none). */
  conversationId?: string
  /** The structured research notebook (plan, sources, findings, images,
   *  coverage). Drives the sheet's plan/coverage view and the report card's
   *  verification/attribution. Absent on legacy tasks. */
  notebook?: ResearchNotebook
  /** Set on completion: the verification pass summary shown on the report card. */
  verification?: ResearchVerification
  /** Absolute epoch-ms deadline (startedAt + 24h). After this the task finalizes a
   *  partial report. Absent on legacy tasks — derive with `taskDeadline`. */
  deadlineAt?: number
  /** While `status === 'paused'`: why it's waiting, shown on the card. */
  pauseReason?: string
  /** While paused: epoch-ms of the next scheduled retry. */
  nextRetryAt?: number
  /** True when the report was cut short by the 24h cap rather than fully converging. */
  partial?: boolean
}

/** The absolute 24h deadline for a task, tolerant of legacy tasks that predate the field. */
export function taskDeadline(t: Pick<ResearchTask, 'startedAt' | 'deadlineAt'>): number {
  return t.deadlineAt ?? t.startedAt + MAX_RESEARCH_DURATION_MS
}

/**
 * Active tasks (`running`/`paused`) whose worker looks dead — no heartbeat for
 * `staleMs`. The watchdog re-dispatches exactly these: within the deadline they
 * resume from the persisted notebook, past it they finalize a partial report.
 * A live-but-quiet task keeps a fresh `updatedAt` (via heartbeat), so it is never
 * selected and never double-run.
 */
export function resumableTasks(
  map: Record<string, ResearchTask>,
  now: number,
  staleMs: number = STALE_MS,
): ResearchTask[] {
  return Object.values(map).filter((t) => isActiveStatus(t.status) && now - t.updatedAt > staleMs)
}

/** The Verify phase's summary: how many cited claims held up. */
export interface ResearchVerification {
  checked: number
  confirmed: number
  hedged: number
  removed: number
  notes?: string[]
}

/** SW↔offscreen↔panel message protocol: panel sends `ensureAndStart`/`cancel`; offscreen sends `start`, `update`, `done`, `error`. */
export type ResearchMsg =
  | { type: 'research.ensureAndStart'; taskId: string; question: string; conversationId: string }
  | {
      type: 'research.start'
      taskId: string
      question: string
      providerConfig: ProviderConfig
      modelId: string
      /** The launching chat, for the research trace's Langfuse session. */
      conversationId?: string
      /** Observability config forwarded from the SW (offscreen has no chrome.storage). */
      observability?: ObservabilityConfig
      /** Absolute 24h deadline; the offscreen host passes it straight to runResearch. */
      deadlineAt?: number
      /** True when this is a resume of a stranded task (Chrome restart / eviction). */
      resume?: boolean
      /** The persisted notebook to resume from, so a resumed task keeps its findings
       *  instead of starting over. */
      notebook?: ResearchNotebook
    }
  | { type: 'research.update'; taskId: string; steps: ResearchStep[]; notebook?: ResearchNotebook }
  // Resilience transitions (offscreen → SW): a phase hit a transient failure and is
  // backing off (`paused`), or a paused phase made progress again (`resumed`).
  | { type: 'research.paused'; taskId: string; reason: string; nextRetryAt: number }
  | { type: 'research.resumed'; taskId: string }
  // Liveness (offscreen → SW): bump `updatedAt` during long, quiet model calls so the
  // watchdog can tell a live worker from a dead one.
  | { type: 'research.heartbeat'; taskId: string }
  | {
      type: 'research.done'
      taskId: string
      report: string
      sources: ResearchSource[]
      notebook?: ResearchNotebook
      verification?: ResearchVerification
    }
  | { type: 'research.error'; taskId: string; error: string }
  | { type: 'research.cancel'; taskId: string }
  // Hybrid-escalation broker (offscreen → SW → offscreen): render a hard page in
  // an isolated controlled tab and return its text/screenshot. See background.ts.
  | { type: 'research.renderPage'; taskId: string; requestId: string; url: string; want: 'text' | 'screenshot' | 'both' }
  | {
      type: 'research.renderResult'
      taskId: string
      requestId: string
      text?: string
      title?: string
      finalUrl?: string
      screenshotDataUrl?: string
      error?: string
    }
  // Interactive browse session (offscreen → SW → offscreen): drive the isolated
  // tab one step at a time — open, act (policy-checked), read, close.
  | { type: 'research.browse'; taskId: string; requestId: string; sessionId: string; op: BrowseOp }
  | { type: 'research.browseResult'; taskId: string; requestId: string; result: BrowseResult }
  // Tab-search fallback (offscreen → SW → offscreen): when the keyless search is
  // rate-limited, run it in a real tab that can clear the bot wall.
  | { type: 'research.searchTab'; taskId: string; requestId: string; query: string; maxResults: number }
  | {
      type: 'research.searchTabResult'
      taskId: string
      requestId: string
      results?: { title: string; url: string; snippet: string }[]
      error?: string
    }

const KEY = 'researchTasks'

// researchTasks shares the ~10MB chrome.storage.local namespace with settings/memory/
// conversations; nothing else removes old task records, so cap growth on every insert.
const MAX_TASKS = 50

// Serialize read-modify-write so concurrent saveTask/applyUpdate calls (e.g. rapid
// research.update bursts) can't interleave a stale get() over a prior set().
let writeChain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)
  writeChain = run.catch(() => {})
  return run
}

async function all(): Promise<Record<string, ResearchTask>> {
  const got = await chrome.storage.local.get(KEY)
  return (got[KEY] as Record<string, ResearchTask>) ?? {}
}

/** Keep the newest `max` tasks by startedAt, but never drop an active (running or
 *  paused) task — a paused task is only waiting for the network, not finished. */
export function pruneTasks(map: Record<string, ResearchTask>, max: number): Record<string, ResearchTask> {
  const all = Object.values(map)
  if (all.length <= max) return map
  const active = all.filter((t) => isActiveStatus(t.status))
  const rest = all
    .filter((t) => !isActiveStatus(t.status))
    .sort((a, b) => b.startedAt - a.startedAt)
  const keep = [...active, ...rest.slice(0, Math.max(0, max - active.length))]
  return Object.fromEntries(keep.map((t) => [t.id, t]))
}

export async function saveTask(t: ResearchTask): Promise<void> {
  await serialize(async () => {
    const map = await all()
    map[t.id] = t
    await chrome.storage.local.set({ [KEY]: pruneTasks(map, MAX_TASKS) })
  })
}

export async function getTask(id: string): Promise<ResearchTask | undefined> {
  return (await all())[id]
}

export async function listTasks(): Promise<ResearchTask[]> {
  return Object.values(await all()).sort((a, b) => b.startedAt - a.startedAt)
}

export async function applyUpdate(
  id: string,
  patch: Partial<ResearchTask> | ((cur: ResearchTask) => Partial<ResearchTask>),
): Promise<ResearchTask | undefined> {
  return serialize(async () => {
    const map = await all()
    const cur = map[id]
    if (!cur) return undefined
    const delta = typeof patch === 'function' ? patch(cur) : patch
    const next = { ...cur, ...delta, updatedAt: Date.now() }
    map[id] = next
    await chrome.storage.local.set({ [KEY]: map })
    return next
  })
}

/**
 * Bump `updatedAt` on an active task without otherwise changing it — the liveness
 * heartbeat the watchdog reads. A no-op for terminal tasks, so a completed report's
 * timestamp is never disturbed.
 */
export async function heartbeat(id: string): Promise<void> {
  await serialize(async () => {
    const map = await all()
    const cur = map[id]
    if (!cur || !isActiveStatus(cur.status)) return
    map[id] = { ...cur, updatedAt: Date.now() }
    await chrome.storage.local.set({ [KEY]: map })
  })
}

/**
 * Drop every saved research task and report. Goes through the same `serialize`
 * chain as the writers, so an in-flight saveTask cannot resurrect the map we just
 * removed by racing its read-modify-write against ours.
 */
export async function clearTasks(): Promise<void> {
  await serialize(async () => {
    await chrome.storage.local.remove(KEY)
  })
}

/** Byte/row estimate for the Data tab. */
export async function tasksUsage(): Promise<StoreUsage> {
  const map = await all()
  const tasks = Object.values(map)
  return {
    bytes: estimateBytes(map),
    count: tasks.length,
    detail: tasks.length === 1 ? '1 report' : `${tasks.length} reports`,
  }
}
