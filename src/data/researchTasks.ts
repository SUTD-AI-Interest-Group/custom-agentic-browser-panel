/** Persisted research-task state + the SW↔offscreen↔panel message protocol. Runs in SW/panel only (never offscreen). */
import type { ProviderConfig } from './settings'

export type ResearchStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface ResearchSource { title: string; url: string }

export interface ResearchTask {
  id: string
  question: string
  status: ResearchStatus
  steps: string[]
  report?: string
  sources?: ResearchSource[]
  error?: string
  startedAt: number
  updatedAt: number
  /** The conversation this research was launched from, so its dock bar and
   *  report card only surface in that chat (legacy tasks lack it and, being
   *  unmatched, surface in none). */
  conversationId?: string
}

/** SW↔offscreen↔panel message protocol: panel sends `ensureAndStart`/`cancel`; offscreen sends `start`, `update`, `done`, `error`. */
export type ResearchMsg =
  | { type: 'research.ensureAndStart'; taskId: string; question: string; conversationId: string }
  | { type: 'research.start'; taskId: string; question: string; providerConfig: ProviderConfig; modelId: string }
  | { type: 'research.update'; taskId: string; step: string }
  | { type: 'research.done'; taskId: string; report: string; sources: ResearchSource[] }
  | { type: 'research.error'; taskId: string; error: string }
  | { type: 'research.cancel'; taskId: string }

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
