/** Persisted research-task state + the SW↔offscreen↔panel message protocol. Runs in SW/panel only (never offscreen). */
import type { ObservabilityConfig, ProviderConfig } from './settings'
import type { ResearchNotebook } from '../agent/notebook'
import type { BrowseAction } from '../tools/browsePolicy'

export type ResearchStatus = 'running' | 'done' | 'error' | 'cancelled'

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
    }
  | { type: 'research.update'; taskId: string; steps: ResearchStep[]; notebook?: ResearchNotebook }
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

/** Keep the newest `max` tasks by startedAt, but never drop a still-running task. */
export function pruneTasks(map: Record<string, ResearchTask>, max: number): Record<string, ResearchTask> {
  const all = Object.values(map)
  if (all.length <= max) return map
  const running = all.filter((t) => t.status === 'running')
  const rest = all
    .filter((t) => t.status !== 'running')
    .sort((a, b) => b.startedAt - a.startedAt)
  const keep = [...running, ...rest.slice(0, Math.max(0, max - running.length))]
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
