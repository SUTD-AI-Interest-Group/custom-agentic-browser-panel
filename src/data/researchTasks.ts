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
}

/** SW↔offscreen↔panel message protocol: panel sends `ensureAndStart`/`cancel`; offscreen sends `start`, `update`, `done`, `error`. */
export type ResearchMsg =
  | { type: 'research.ensureAndStart'; taskId: string; question: string }
  | { type: 'research.start'; taskId: string; question: string; providerConfig: ProviderConfig; modelId: string }
  | { type: 'research.update'; taskId: string; step: string }
  | { type: 'research.done'; taskId: string; report: string; sources: ResearchSource[] }
  | { type: 'research.error'; taskId: string; error: string }
  | { type: 'research.cancel'; taskId: string }

const KEY = 'researchTasks'

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

export async function saveTask(t: ResearchTask): Promise<void> {
  await serialize(async () => {
    const map = await all()
    map[t.id] = t
    await chrome.storage.local.set({ [KEY]: map })
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
