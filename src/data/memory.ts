// Long-term memory, housed in IndexedDB (extension origin, so it is shared
// between the side panel and the background service worker).
//
// Two object stores:
//   episodes  — raw journal of conversations as they happen. Cheap to write,
//               never shown to the model during normal chat.
//   memories  — small, durable, distilled facts. These are what get recalled
//               into the system prompt and searched by the SearchMemory tool.
//
// Episodes become memories through "dreaming" (see dream.ts): the model
// periodically reviews unconsolidated episodes and rewrites the memory store.

import { estimateBytes, type StoreUsage } from './usage'

export type MemoryKind = 'fact' | 'preference' | 'project' | 'summary' | 'profile'
export type MemorySource = 'dream' | 'agent' | 'user'

export interface MemoryRecord {
  id: string
  kind: MemoryKind
  /** The memory itself, one self-contained sentence or short paragraph. */
  content: string
  tags: string[]
  createdAt: number
  updatedAt: number
  lastRecalledAt: number | null
  recallCount: number
  source: MemorySource
}

export interface EpisodeMessage {
  role: 'user' | 'assistant'
  text: string
  at: number
}

export interface EpisodeRecord {
  id: string
  startedAt: number
  updatedAt: number
  /** Set by the dream cycle once this episode has been distilled. */
  consolidated: boolean
  messages: EpisodeMessage[]
}

const DB_NAME = 'lychee-memory'
const DB_VERSION = 1
const MEMORIES = 'memories'
const EPISODES = 'episodes'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(MEMORIES)) db.createObjectStore(MEMORIES, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(EPISODES)) db.createObjectStore(EPISODES, { keyPath: 'id' })
      }
      req.onsuccess = () => {
        // If another context (panel vs worker) upgrades later, drop our handle.
        req.result.onversionchange = () => {
          req.result.close()
          dbPromise = null
        }
        resolve(req.result)
      }
      req.onerror = () => {
        dbPromise = null
        reject(req.error)
      }
    })
  }
  return dbPromise
}

function requestOf<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(store, mode).objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

export async function saveMemory(input: {
  kind: MemoryKind
  content: string
  tags?: string[]
  source: MemorySource
}): Promise<MemoryRecord> {
  const now = Date.now()
  const record: MemoryRecord = {
    id: crypto.randomUUID(),
    kind: input.kind,
    content: input.content.trim(),
    tags: (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
    createdAt: now,
    updatedAt: now,
    lastRecalledAt: null,
    recallCount: 0,
    source: input.source,
  }
  await requestOf(MEMORIES, 'readwrite', (s) => s.put(record))
  return record
}

export async function updateMemory(
  id: string,
  patch: Partial<Pick<MemoryRecord, 'kind' | 'content' | 'tags'>>,
): Promise<MemoryRecord | null> {
  const existing = await requestOf<MemoryRecord | undefined>(MEMORIES, 'readonly', (s) => s.get(id))
  if (!existing) return null
  const next: MemoryRecord = { ...existing, ...patch, updatedAt: Date.now() }
  await requestOf(MEMORIES, 'readwrite', (s) => s.put(next))
  return next
}

export async function deleteMemory(id: string): Promise<void> {
  await requestOf(MEMORIES, 'readwrite', (s) => s.delete(id))
}

export async function listMemories(): Promise<MemoryRecord[]> {
  const all = await requestOf<MemoryRecord[]>(MEMORIES, 'readonly', (s) => s.getAll())
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Memories the user has marked as reusable profile fields (name, email, address…) for form autofill. */
export async function getProfileMemories(): Promise<MemoryRecord[]> {
  return (await listMemories()).filter((m) => m.kind === 'profile')
}

/**
 * Keyword search with a light recency boost. No embeddings on purpose: the
 * store is small (tens of memories), everything stays local, and the model
 * can always issue a second query with different terms.
 */
export async function searchMemories(query: string, limit = 8): Promise<MemoryRecord[]> {
  const all = await listMemories()
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1)
  if (terms.length === 0) return all.slice(0, limit)

  const now = Date.now()
  const scored = all
    .map((m) => {
      const haystack = `${m.content} ${m.tags.join(' ')} ${m.kind}`.toLowerCase()
      let score = 0
      for (const term of terms) if (haystack.includes(term)) score += 1
      // Half-life of ~30 days keeps fresh memories slightly ahead on ties.
      const ageDays = (now - m.updatedAt) / 86_400_000
      return { m, score: score + 0.5 * Math.pow(0.5, ageDays / 30) }
    })
    .filter((s) => s.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const hits = scored.map((s) => s.m)
  await Promise.all(
    hits.map((m) =>
      requestOf(MEMORIES, 'readwrite', (s) =>
        s.put({ ...m, lastRecalledAt: now, recallCount: m.recallCount + 1 }),
      ),
    ),
  )
  return hits
}

/**
 * Formats the most relevant memories as a system-prompt block, or '' when the
 * store is empty. Injected at the start of every agent turn so the assistant
 * "wakes up" already knowing the user.
 */
export async function getMemoryContext(limit = 20): Promise<string> {
  const all = await listMemories()
  if (all.length === 0) return ''
  const picked = all.slice(0, limit)
  const lines = picked.map((m) => `- [${m.kind}] ${m.content}`)
  const omitted = all.length - picked.length
  return [
    '## Long-term memory',
    'Things you remember about this user from past conversations (maintained by your nightly memory consolidation). Use them naturally; verify with the user if one seems outdated.',
    ...lines,
    ...(omitted > 0 ? [`(${omitted} older memories omitted — use SearchMemory to look them up.)`] : []),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Episodes (conversation journal)
// ---------------------------------------------------------------------------

export async function appendToEpisode(id: string, messages: EpisodeMessage[]): Promise<void> {
  const existing = await requestOf<EpisodeRecord | undefined>(EPISODES, 'readonly', (s) => s.get(id))
  const now = Date.now()
  const record: EpisodeRecord = existing ?? {
    id,
    startedAt: now,
    updatedAt: now,
    consolidated: false,
    messages: [],
  }
  record.messages.push(...messages)
  record.updatedAt = now
  await requestOf(EPISODES, 'readwrite', (s) => s.put(record))
}

export async function listUnconsolidatedEpisodes(): Promise<EpisodeRecord[]> {
  const all = await requestOf<EpisodeRecord[]>(EPISODES, 'readonly', (s) => s.getAll())
  return all.filter((e) => !e.consolidated && e.messages.length > 0).sort((a, b) => a.startedAt - b.startedAt)
}

export async function markEpisodesConsolidated(ids: string[]): Promise<void> {
  for (const id of ids) {
    const e = await requestOf<EpisodeRecord | undefined>(EPISODES, 'readonly', (s) => s.get(id))
    if (e) await requestOf(EPISODES, 'readwrite', (s) => s.put({ ...e, consolidated: true }))
  }
}

/** Consolidated episodes are kept briefly for debugging, then dropped. */
export async function pruneConsolidatedEpisodes(olderThanMs = 14 * 86_400_000): Promise<void> {
  const all = await requestOf<EpisodeRecord[]>(EPISODES, 'readonly', (s) => s.getAll())
  const cutoff = Date.now() - olderThanMs
  for (const e of all) {
    if (e.consolidated && e.updatedAt < cutoff) {
      await requestOf(EPISODES, 'readwrite', (s) => s.delete(e.id))
    }
  }
}

/**
 * Wipe long-term memory *and* the episode log the dreamer consolidates from,
 * and reset the dream state so the panel reads "Has not dreamed yet" again. This
 * is the single "reset memory entirely" path — the Dreaming panel's Reset button,
 * the Data tab's Clear Memory, and the full erase all route through it.
 */
export async function clearMemory(): Promise<void> {
  await requestOf(MEMORIES, 'readwrite', (s) => s.clear())
  await requestOf(EPISODES, 'readwrite', (s) => s.clear())
  await clearDreamState()
}

// ---------------------------------------------------------------------------
// Dream state — the last-consolidation metadata shown in the Dreaming panel.
// Kept here (not in dream.ts) so `clearMemory` can reset it without pulling the
// AI SDK into this store, and so a "reset memory" wipes it in one call.
// ---------------------------------------------------------------------------

export interface DreamState {
  lastDreamAt: number | null
  /** Day summary produced by the last dream, for display in the Memory panel. */
  lastSummary: string | null
}

const DREAM_STATE_KEY = 'dreamState'

export async function getDreamState(): Promise<DreamState> {
  const data = await chrome.storage.local.get(DREAM_STATE_KEY)
  return { lastDreamAt: null, lastSummary: null, ...(data[DREAM_STATE_KEY] as Partial<DreamState> | undefined) }
}

export async function setDreamState(state: DreamState): Promise<void> {
  await chrome.storage.local.set({ [DREAM_STATE_KEY]: state })
}

export async function clearDreamState(): Promise<void> {
  await chrome.storage.local.remove(DREAM_STATE_KEY)
}

/** Byte/row estimate for the Data tab, counting both object stores. */
export async function memoryUsage(): Promise<StoreUsage> {
  const memories = await requestOf<MemoryRecord[]>(MEMORIES, 'readonly', (s) => s.getAll())
  const episodes = await requestOf<EpisodeRecord[]>(EPISODES, 'readonly', (s) => s.getAll())
  const eps = episodes.length === 1 ? '1 episode' : `${episodes.length} episodes`
  return {
    bytes: estimateBytes(memories) + estimateBytes(episodes),
    count: memories.length,
    detail: `${memories.length} memories · ${eps}`,
  }
}
