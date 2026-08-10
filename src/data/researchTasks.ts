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
  /** What the launching conversation already established, prepended to Scope & Plan. */
  brief?: string
  /** Seed coverage from the launch card. */
  subQuestions?: string[]
  /** Source scope (registrable hosts). Empty/absent = unrestricted. Retained so a
   *  resumed task keeps the scope the user approved. */
  sites?: string[]
  /** Documents the user attached at launch, by reference. Retained so a resumed
   *  task can still read them. */
  attachments?: ResearchAttachmentRef[]
}

/**
 * A document the user attached to a research launch, carried by REFERENCE only.
 *
 * Bytes never cross the message boundary: the offscreen research host opens the
 * same `lychee-attachments` IndexedDB the panel wrote to (it is an extension
 * page, so same origin — and it already reads IndexedDB to dream) and resolves
 * `id` itself. The rest of these fields exist so the launch card, the step log
 * and the report's citation chip can name the document without a round-trip.
 *
 * The store is capped by size and age while research runs to a 24h deadline, so
 * a task can outlive its own attachment. Readers must treat a missing record as
 * a stated "no longer available", never as a failure of the run.
 */
export interface ResearchAttachmentRef {
  id: string
  name: string
  kind: 'image' | 'pdf' | 'text' | 'document'
  /** PDFs only — lets the launch card and ReadAttachment show extents up front. */
  pageCount?: number
}

/**
 * A launch card awaiting Start. Lives on the transcript message, NOT in
 * `researchTasks` storage — so a proposal the user never starts leaves no row
 * for the resume watchdog to find and no status for `isActiveStatus` to model.
 * `taskId` is minted here and becomes `ResearchTask.id` on Start, which is what
 * lets the launch card, the live card and the report share one slot.
 */
export interface ResearchProposal {
  taskId: string
  question: string
  brief?: string
  subQuestions: string[]
  /** Registrable hosts; empty means unrestricted. */
  sites: string[]
  premise?: { asserted: string; corrected: string }
  clarifications?: string[]
  /** Documents the user attached to the armed message, by reference. */
  attachments?: ResearchAttachmentRef[]
  /**
   * True while the framing call is still in flight.
   *
   * The card is rendered BEFORE that call, carrying the user's raw message as
   * the question, and filled in when it returns. Awaiting first meant an armed
   * send showed nothing at all until the model answered — up to two chained
   * 20s timeouts on a slow or structured-output-shy endpoint — which is
   * indistinguishable from the feature being broken.
   */
  framing?: boolean
  /** Set when framing failed. The card still works (the raw question is a
   *  perfectly good one), but the user is told it was not refined rather than
   *  silently getting a less useful card. */
  framingError?: string
  /** Epoch ms the framing call produced this, so a stale brief reads as stale. */
  draftedAt: number
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
  | {
      type: 'research.ensureAndStart'
      taskId: string
      question: string
      conversationId: string
      /** What the launching conversation already established, prepended to Scope & Plan. */
      brief?: string
      /** Seed coverage from the launch card. */
      subQuestions?: string[]
      /** Source scope (registrable hosts). Empty/absent = unrestricted. */
      sites?: string[]
      /** Documents attached at launch, by reference — bytes stay in IndexedDB. */
      attachments?: ResearchAttachmentRef[]
    }
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
      /** What the launching conversation already established, prepended to Scope & Plan. */
      brief?: string
      /** Seed coverage from the launch card. */
      subQuestions?: string[]
      /** Source scope (registrable hosts). Empty/absent = unrestricted. */
      sites?: string[]
      /** Documents attached at launch, by reference — the host resolves the bytes
       *  itself from IndexedDB. */
      attachments?: ResearchAttachmentRef[]
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
      /** True when the report was cut short by the 24h cap rather than converging. */
      partial?: boolean
    }
  | { type: 'research.error'; taskId: string; error: string }
  | { type: 'research.cancel'; taskId: string }
  // Panel → SW: perform the actual removal of all saved tasks. The panel never
  // writes the `researchTasks` key directly (see clearTasks()'s doc comment
  // below) — only the SW does, so this, like every other write, funnels through
  // the ONE writeChain below instead of racing it from a second context.
  | { type: 'research.clearTasks' }
  // Hybrid-escalation broker (offscreen → SW → offscreen): render a hard page in
  // an isolated controlled tab and return its text. See background.ts. Text
  // only — see researchRender.ts's module header for why a screenshot mode
  // was removed rather than wired up.
  | { type: 'research.renderPage'; taskId: string; requestId: string; url: string }
  | {
      type: 'research.renderResult'
      taskId: string
      requestId: string
      text?: string
      title?: string
      finalUrl?: string
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
  // Shutdown (offscreen → SW): the host has nothing left to do — no research task
  // running AND no dream cycle in flight. Only the host can say this, since it is
  // the one context that sees both tenants; the SW answers by closing the document
  // (re-checking storage for an active task first, in case one was dispatched in
  // the gap). Nothing is lost if this message is dropped — ensureOffscreen
  // recreates the host on demand, and the worst case is a document that lives
  // until the next task finishes.
  | { type: 'offscreen.idle' }

/**
 * Send one research message, fire-and-forget. Every hop in this protocol is
 * one-way — replies come back as their own `*Result` message, never as a
 * sendResponse — but `chrome.runtime.sendMessage` returns a promise that
 * *rejects* whenever the other end isn't there to take it: a panel the user just
 * closed, an offscreen host evicted mid-task, a listener that closed the channel
 * without answering. Unhandled, each of those lands in chrome://extensions as an
 * "Uncaught (in promise)" error even though the protocol is designed to tolerate
 * a dropped message (the SW re-derives state from storage; the watchdog
 * re-dispatches). Swallowing here is the contract, in one place, rather than a
 * `.catch(() => {})` every caller has to remember.
 */
export function postResearchMsg(msg: ResearchMsg): void {
  void chrome.runtime.sendMessage(msg).catch(() => {})
}

const KEY = 'researchTasks'

// researchTasks shares the ~10MB chrome.storage.local namespace with settings/memory/
// conversations; nothing else removes old task records, so cap growth on every insert.
const MAX_TASKS = 50

// A `research.update` message carries the FULL derived step list every time (see
// background.ts — "replace rather than append"), so a long-running task's log grows
// without bound: hours of gather/reflect rounds easily produce thousands of entries,
// each with a bounded-but-nonzero `detail` blob. 200 is generous for what a user
// actually reads in the sheet (recent activity) while keeping one task's record from
// crowding out the other 49 under the shared quota.
const MAX_STEPS = 200

/** Cap a task's step log to the most recent `max` entries. When entries are
 *  trimmed, a single marker `phase` step is prepended so the sheet shows that
 *  earlier history was dropped rather than silently starting mid-log. Pure and
 *  idempotent — safe to call on every persisted update, not just once.
 *
 *  The marker itself counts toward `max` (kept = max − 1 real steps + 1 marker):
 *  without that, trimming an already-at-the-cap array produced max + 1 entries,
 *  which is STILL over the cap, so a second call would re-trim and replace the
 *  marker again — discarding the original drop-count and understating how much
 *  history was actually lost across repeated calls. That is not hypothetical:
 *  the live step log (research.ts's emit()) now caps its own onUpdate payload
 *  the same way, so a `research.update` message routinely already IS a
 *  previously-capped array by the time applyUpdate() caps it again for storage. */
export function capSteps(steps: ResearchStep[], max: number = MAX_STEPS): ResearchStep[] {
  if (steps.length <= max) return steps
  const kept = Math.max(0, max - 1)
  const dropped = steps.length - kept
  const marker: ResearchStep = {
    tool: 'Log',
    summary: `…${dropped} earlier step${dropped === 1 ? '' : 's'} trimmed`,
    detail: 'Older entries were dropped to keep this task’s stored record within the shared storage quota.',
    status: 'done',
    kind: 'phase',
  }
  return [marker, ...steps.slice(-kept)]
}

// Serialize read-modify-write so concurrent saveTask/applyUpdate/heartbeat/
// clearTasksNow calls (e.g. rapid research.update bursts racing a clear) can't
// interleave a stale get() over a prior set() — see clearTasks()'s doc comment
// for why this only works because ALL of them run in this one context (the SW).
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
    map[t.id] = { ...t, steps: capSteps(t.steps) }
    try {
      await chrome.storage.local.set({ [KEY]: pruneTasks(map, MAX_TASKS) })
    } catch (err) {
      // A quota/storage failure here would otherwise be a silent unhandled rejection
      // in the fire-and-forget message listener that calls this.
      console.error('[researchTasks] persist failed', err)
    }
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
    if (next.steps) next.steps = capSteps(next.steps)
    map[id] = next
    try {
      await chrome.storage.local.set({ [KEY]: map })
    } catch (err) {
      console.error('[researchTasks] persist failed', err)
    }
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
    try {
      await chrome.storage.local.set({ [KEY]: map })
    } catch (err) {
      console.error('[researchTasks] persist failed', err)
    }
  })
}

/**
 * Drop every saved research task and report.
 *
 * The SW is the only context allowed to touch the `researchTasks` key directly —
 * saveTask/applyUpdate/heartbeat above all run there (background.ts's message
 * handler), each funneled through the shared `serialize()` writeChain, which
 * fully orders every write within that ONE context. This function used to ALSO
 * write directly from wherever it was called, including the side panel (via
 * storage.ts's clearStore/eraseAllData) — a SEPARATE JS execution context with
 * its own module-scope writeChain that knows nothing of the SW's, so a
 * panel-issued clear could interleave with an in-flight SW write with no way to
 * serialize the two against each other. An earlier fix mitigated that with a
 * storage-backed "clearedAt" marker every writer rechecked immediately before its
 * own write — narrowing the race window, not closing it (a pathological-enough
 * interleaving between the recheck and the write could still land wrong).
 *
 * The actual fix is routing every write through the SW, no exceptions: called
 * from within the SW itself (detected by the absence of a `window` global — a
 * service worker has no DOM/window, unlike the panel or an offscreen document),
 * this clears directly on the SAME writeChain saveTask/applyUpdate/heartbeat use,
 * so it can never interleave with them. Called from anywhere else (the panel,
 * today the only other caller), it asks the SW to do it via a message instead of
 * touching storage itself — background.ts's `research.clearTasks` handler calls
 * clearTasksNow() below, the very function this uses internally. Either way
 * there is exactly one writer of this key, ever, which is why the clearedAt
 * marker was removed rather than kept alongside this: once there is only one
 * writer left, a recheck-before-write guard against a SECOND writer can never
 * fire again, and inert defensive code is worse than no code — it reads as "there
 * must still be a second writer, that's why this check exists" to the next
 * person, which is no longer true.
 */
export async function clearTasks(): Promise<void> {
  if (typeof window === 'undefined') {
    // No `window` global: this module instance IS the service worker.
    await clearTasksNow()
    return
  }
  // Any other context (the side panel, today the only other caller): route
  // through the SW instead of writing chrome.storage.local from here.
  // chrome.runtime.sendMessage wakes the SW if it is idle and keeps it alive
  // until background.ts's handler calls sendResponse(), so this is not weaker
  // than a direct write for reliability — only for the one property that
  // actually matters here, that it can no longer race the SW's own writeChain.
  await chrome.runtime.sendMessage({ type: 'research.clearTasks' } satisfies ResearchMsg)
}

/**
 * The actual removal. Only ever reached from within the SW: directly, above,
 * when this module instance IS the SW; or via background.ts's
 * `research.clearTasks` message handler when relaying a panel-issued clear.
 * Exported (rather than kept private) specifically so background.ts can call it.
 */
export async function clearTasksNow(): Promise<void> {
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
