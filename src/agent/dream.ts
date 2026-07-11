// "Model dreaming": periodic memory consolidation, loosely modeled on what
// sleep does for humans. While the user is away, the model re-reads the day's
// raw conversation journal (episodes) alongside its current long-term
// memories, and rewrites the memory store — adding durable facts, merging
// duplicates, forgetting stale entries, and writing a compact day summary.
//
// Runs in two places: the background service worker on an hourly alarm
// (dreamIfDue), and on demand from the Memory panel ("Dream now" → runDream).
// It is a single non-streaming generateText call, so it works fine in a
// service worker with no DOM.

import { generateText } from 'ai'
import { createModel } from './provider'
import { getObserver } from './observability'
import { getSelectedProvider, loadSettings, observabilityConfig } from '../data/settings'
import {
  deleteMemory,
  listMemories,
  listUnconsolidatedEpisodes,
  markEpisodesConsolidated,
  pruneConsolidatedEpisodes,
  saveMemory,
  updateMemory,
  type EpisodeRecord,
  type MemoryKind,
  type MemoryRecord,
} from '../data/memory'

export interface DreamState {
  lastDreamAt: number | null
  /** Day summary produced by the last dream, for display in the Memory panel. */
  lastSummary: string | null
}

export type DreamOutcome =
  | { status: 'dreamed'; added: number; updated: number; deleted: number; episodes: number; summary: string | null }
  | { status: 'skipped'; reason: string }

const STATE_KEY = 'dreamState'

// Don't dream more than ~once a day, and never mid-conversation.
const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000
const MIN_IDLE_MS = 30 * 60 * 1000

const VALID_KINDS: MemoryKind[] = ['fact', 'preference', 'project', 'summary']
const MAX_ADDS_PER_DREAM = 12
const MAX_MEMORY_CHARS = 600
const MAX_MESSAGE_CHARS = 1_500
const MAX_TRANSCRIPT_CHARS = 24_000

export async function getDreamState(): Promise<DreamState> {
  const data = await chrome.storage.local.get(STATE_KEY)
  return { lastDreamAt: null, lastSummary: null, ...(data[STATE_KEY] as Partial<DreamState> | undefined) }
}

async function setDreamState(state: DreamState): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: state })
}

/** Alarm entry point: dream only when due and the user has gone quiet. */
export async function dreamIfDue(): Promise<DreamOutcome> {
  const state = await getDreamState()
  if (state.lastDreamAt && Date.now() - state.lastDreamAt < MIN_INTERVAL_MS) {
    return { status: 'skipped', reason: 'Dreamed recently.' }
  }
  const episodes = await listUnconsolidatedEpisodes()
  if (episodes.length === 0) return { status: 'skipped', reason: 'Nothing new to consolidate.' }
  const lastActivity = Math.max(...episodes.map((e) => e.updatedAt))
  if (Date.now() - lastActivity < MIN_IDLE_MS) {
    return { status: 'skipped', reason: 'User is still active.' }
  }
  return runDream()
}

/** Runs one full dream cycle immediately (used by the "Dream now" button). */
export async function runDream(): Promise<DreamOutcome> {
  const settings = await loadSettings()
  const selected = getSelectedProvider(settings)
  if (!selected) return { status: 'skipped', reason: 'No model configured.' }

  const episodes = await listUnconsolidatedEpisodes()
  if (episodes.length === 0) return { status: 'skipped', reason: 'Nothing new to consolidate.' }
  const memories = await listMemories()

  // Observability: the dream is a single generation, in its own trace (no chat
  // session — it runs in the background service worker).
  const observer = getObserver(observabilityConfig(settings))
  const trace = observer.enabled
    ? observer.startTrace({ name: 'dream', tags: ['dreaming'] })
    : undefined
  const prompt = buildDreamPrompt(memories, episodes)
  const gen = trace?.generation({ name: 'dream', model: selected.modelId, input: prompt })

  let text: string
  try {
    const res = await generateText({
      model: createModel(selected.provider, selected.modelId),
      // v7 renamed `system` to `instructions` (`system` still works, deprecated).
      instructions: DREAM_SYSTEM_PROMPT,
      prompt,
    })
    text = res.text
    gen?.end({ output: text, usage: res.usage })
  } catch (err) {
    gen?.end({ level: 'ERROR', statusMessage: err instanceof Error ? err.message : String(err) })
    trace?.end()
    await observer.flush()
    throw err
  }

  const ops = parseDreamOps(text)
  if (!ops) {
    trace?.end({ metadata: { parseError: true } })
    await observer.flush()
    return { status: 'skipped', reason: 'Model returned unparseable output; will retry next cycle.' }
  }

  let added = 0
  let updated = 0
  let deleted = 0

  for (const op of ops.add.slice(0, MAX_ADDS_PER_DREAM)) {
    await saveMemory({ ...op, source: 'dream' })
    added++
  }
  for (const op of ops.update) {
    if (await updateMemory(op.id, op.patch)) updated++
  }
  for (const id of ops.delete) {
    if (memories.some((m) => m.id === id)) {
      await deleteMemory(id)
      deleted++
    }
  }
  if (ops.daySummary) {
    await saveMemory({ kind: 'summary', content: ops.daySummary, tags: ['day-summary'], source: 'dream' })
    added++
  }

  await markEpisodesConsolidated(episodes.map((e) => e.id))
  await pruneConsolidatedEpisodes()
  await setDreamState({ lastDreamAt: Date.now(), lastSummary: ops.daySummary })

  trace?.end({
    output: ops.daySummary ?? undefined,
    metadata: { added, updated, deleted, episodes: episodes.length },
  })
  await observer.flush()

  return { status: 'dreamed', added, updated, deleted, episodes: episodes.length, summary: ops.daySummary }
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

const DREAM_SYSTEM_PROMPT = `You are the memory-consolidation process of an AI assistant that lives in the user's browser — the assistant's "dreaming". While the user is away you review recent conversation transcripts and curate the assistant's long-term memory so that future conversations start with useful context.

Distill only what is durable and will still matter in future conversations:
- fact: stable information about the user or their world (name, role, tools they use, ...)
- preference: how the user wants the assistant to behave (tone, format, language, ...)
- project: ongoing work or goals, phrased with enough context to be useful weeks later; include concrete dates instead of "today" or "yesterday"
- summary: reserved for the daySummary field — do not add memories of kind "summary" yourself

Curation rules:
- Prefer few, high-value memories. Most small talk produces none.
- Each memory must be one self-contained sentence (or two) understandable without the transcript.
- If a transcript refines or contradicts an existing memory, UPDATE or DELETE that memory rather than adding a near-duplicate.
- Delete existing memories that are clearly stale, wrong, or superseded.
- Never store secrets: passwords, API keys, one-time codes, full card numbers.
- daySummary: one compact paragraph capturing what the user worked on and cared about in these conversations, or null if nothing noteworthy happened.

Respond with ONLY a JSON object, no markdown fences, no commentary:
{
  "add": [{ "kind": "fact|preference|project", "content": "...", "tags": ["..."] }],
  "update": [{ "id": "<existing memory id>", "content": "...", "tags": ["..."] }],
  "delete": ["<existing memory id>"],
  "daySummary": "..." or null
}`

function buildDreamPrompt(memories: MemoryRecord[], episodes: EpisodeRecord[]): string {
  const memoryBlock =
    memories.length === 0
      ? '(no memories yet)'
      : memories
          .map((m) => `- id=${m.id} [${m.kind}] (updated ${new Date(m.updatedAt).toISOString().slice(0, 10)}) ${m.content}`)
          .join('\n')

  let budget = MAX_TRANSCRIPT_CHARS
  const transcripts: string[] = []
  // Newest episodes first when trimming, but present them chronologically.
  for (const e of [...episodes].reverse()) {
    if (budget <= 0) break
    const lines = e.messages.map((m) => {
      const text = m.text.length > MAX_MESSAGE_CHARS ? `${m.text.slice(0, MAX_MESSAGE_CHARS)} […]` : m.text
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`
    })
    const block = `### Conversation (${new Date(e.startedAt).toISOString()})\n${lines.join('\n')}`
    budget -= block.length
    transcripts.unshift(block)
  }
  if (transcripts.length < episodes.length) {
    transcripts.unshift(`(${episodes.length - transcripts.length} older conversations omitted for length)`)
  }

  return [
    `Current date: ${new Date().toISOString().slice(0, 10)}`,
    '',
    '## Current long-term memories',
    memoryBlock,
    '',
    '## Recent conversations to consolidate',
    transcripts.join('\n\n'),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Output parsing — defensive, the model's JSON discipline varies.
// ---------------------------------------------------------------------------

interface DreamOps {
  add: Array<{ kind: MemoryKind; content: string; tags: string[] }>
  update: Array<{ id: string; patch: { content?: string; tags?: string[] } }>
  delete: string[]
  daySummary: string | null
}

function parseDreamOps(text: string): DreamOps | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>

  const add: DreamOps['add'] = []
  if (Array.isArray(obj.add)) {
    for (const item of obj.add) {
      if (typeof item !== 'object' || item === null) continue
      const { kind, content, tags } = item as Record<string, unknown>
      if (typeof content !== 'string' || !content.trim()) continue
      add.push({
        kind: VALID_KINDS.includes(kind as MemoryKind) && kind !== 'summary' ? (kind as MemoryKind) : 'fact',
        content: content.trim().slice(0, MAX_MEMORY_CHARS),
        tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [],
      })
    }
  }

  const update: DreamOps['update'] = []
  if (Array.isArray(obj.update)) {
    for (const item of obj.update) {
      if (typeof item !== 'object' || item === null) continue
      const { id, content, tags } = item as Record<string, unknown>
      if (typeof id !== 'string') continue
      const patch: { content?: string; tags?: string[] } = {}
      if (typeof content === 'string' && content.trim()) patch.content = content.trim().slice(0, MAX_MEMORY_CHARS)
      if (Array.isArray(tags)) patch.tags = tags.filter((t): t is string => typeof t === 'string')
      if (Object.keys(patch).length > 0) update.push({ id, patch })
    }
  }

  const del = Array.isArray(obj.delete) ? obj.delete.filter((d): d is string => typeof d === 'string') : []
  const daySummary =
    typeof obj.daySummary === 'string' && obj.daySummary.trim()
      ? obj.daySummary.trim().slice(0, MAX_MEMORY_CHARS * 2)
      : null

  return { add, update, delete: del, daySummary }
}
