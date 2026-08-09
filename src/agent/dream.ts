// "Model dreaming": periodic memory consolidation, loosely modeled on what
// sleep does for humans. While the user is away, the model re-reads the day's
// raw conversation journal (episodes) alongside its current long-term
// memories, and rewrites the memory store — adding durable facts, merging
// duplicates, forgetting stale entries, and writing a compact day summary.
//
// A cycle is split across two halves, because no single realm can host both:
//
//  - runDreamCycle — the model call plus the IndexedDB reads/writes it feeds.
//    Deliberately free of chrome.storage, so it can run in the offscreen
//    document, where "the `runtime` API is the only extensions API supported".
//  - the settle half (settleDreamCycle / completeDispatchedDream) — the
//    chrome.storage bookkeeping: dream state and the reentrancy lock.
//
// The split exists because the MV3 service worker cannot be trusted to host the
// generation: Chrome terminates a service worker "when a single request, such as
// an event or API call, takes longer than 5 minutes to process", and one
// non-streaming generation over MAX_TRANSCRIPT_CHARS of transcript can take that
// long against a local or heavily-loaded model.
//
// Measured, not assumed (Chrome for Testing 141): with the whole cycle awaited
// inside the alarm handler, a 6-minute generation was killed mid-flight — the
// finished response was thrown away, the episodes stayed unconsolidated, and the
// dream lock was left HELD, blocking every retry (and the user's own "Dream
// now") until its TTL expired. A 45-second one survived, so Chrome's other
// documented bullet — "when a `fetch()` response takes more than 30 seconds to
// arrive" — did not bite in that build. The 5-minute one is the real ceiling.
//
// The alarm therefore evaluates the gates, takes the lock, and hands the job to
// the offscreen host (dreamIfDue's `dispatch`), whose later result message
// revives the worker to settle it. The worker never awaits the generation, so it
// can no longer be killed in the middle of one.
//
// Three entry points, two paths:
//  - the alarm (background.ts) → dreamIfDue(dispatch) → offscreen → settle;
//  - "Dream now" (Memory panel) → runDream → both halves in the panel, which
//    has chrome.storage AND no fetch ceiling;
//  - the alarm with no dispatcher → runDream, the pre-split behavior, kept so
//    the function is still usable from any chrome.storage-capable realm.
//
// Every path takes the lock before either half runs (see acquireDreamLock
// below), so a dispatched cycle and a "Dream now" can never interleave.

import { generateText } from 'ai'
import { createModel } from './provider'
import { getObserver } from './observability'
import { PER_ATTEMPT_TIMEOUT_MS } from './resilience'
import {
  getDreamProvider,
  loadSettings,
  observabilityConfig,
  resolveDreamIntervalMs,
  type ObservabilityConfig,
  type ProviderConfig,
  type Settings,
} from '../data/settings'
import {
  clearDreamLock,
  deleteMemory,
  getDreamLock,
  getDreamState,
  listMemories,
  listUnconsolidatedEpisodes,
  markEpisodesConsolidated,
  pruneConsolidatedEpisodes,
  saveMemory,
  setDreamLock,
  setDreamState,
  updateMemory,
  type EpisodeRecord,
  type MemoryKind,
  type MemoryRecord,
} from '../data/memory'

// Dream-state persistence (get/set/clear) lives in ../data/memory so that
// clearMemory() can reset it in the same call; this module just reads/writes it.

export type DreamOutcome =
  | { status: 'dreamed'; added: number; updated: number; deleted: number; episodes: number; summary: string | null }
  | { status: 'skipped'; reason: string }
  /** Handed to the offscreen host; its outcome lands later, via completeDispatchedDream. */
  | { status: 'dispatched' }

/**
 * Everything runDreamCycle needs that only a chrome.storage-capable realm can
 * resolve. Crosses a chrome.runtime message to the offscreen host, so it must
 * stay JSON-safe — and, like research's own hand-off, it carries the provider
 * config (API key included) in a runtime message rather than expecting the
 * receiving realm to read storage, which it cannot.
 */
export interface DreamJob {
  provider: ProviderConfig
  modelId: string
  /** Passed explicitly: the offscreen host cannot read its own config from storage. */
  observability?: ObservabilityConfig
}

/**
 * What one cycle did, in JSON-safe form so it can travel back from the offscreen
 * host. Deliberately NOT a DreamOutcome: the user-facing wording (and the
 * consecutive-parse-failure counter behind it) needs chrome.storage, which only
 * the settle half has.
 */
export type DreamCycleResult =
  | { kind: 'consolidated'; added: number; updated: number; deleted: number; episodes: number; summary: string | null }
  /** Nothing pending by the time the cycle actually started. */
  | { kind: 'nothing' }
  /** The model answered, but not with parseable ops. `episodes` is what stayed pending. */
  | { kind: 'unparseable'; episodes: number }

/** Hands a job to a realm that can run it, holding the lock `token` for the caller. */
export type DreamDispatch = (job: DreamJob, token: string) => Promise<void>

// Never dream mid-conversation — only after the user has gone quiet. The gap
// *between* dreams is user-configurable (resolveDreamIntervalMs); this idle
// guard is not, so a short interval still won't interrupt active use.
const MIN_IDLE_MS = 30 * 60 * 1000

// A lastDreamAt (or lock timestamp, see isLockStale) more than this far in the
// future indicates the system clock was briefly wrong when it was recorded
// (NTP correction, manual clock change, VM snapshot restore) and has since
// moved back — not a real future dream. Treated as invalid rather than
// trusted, so one clock blip doesn't block dreaming until the real clock
// naturally catches up to a bogus value that could be arbitrarily far ahead.
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000

// Bounds the generateText call below (see runDream) so a hung provider
// socket can't wedge a dream cycle — and, with it, the lock that guards it —
// forever. Reuses the research pipeline's own per-attempt timeout
// (resilience.ts) rather than inventing a new number: an attempt here is a
// single non-streaming generation that can legitimately be slow against a
// local model, so the bound must comfortably exceed normal latency and
// exist only to break a genuinely stuck connection — exactly
// PER_ATTEMPT_TIMEOUT_MS's own reasoning.
export const DREAM_MODEL_TIMEOUT_MS = PER_ATTEMPT_TIMEOUT_MS

/**
 * Comfortably longer than one real dream cycle can now legitimately take:
 * the generateText call is capped at DREAM_MODEL_TIMEOUT_MS and the
 * observability flush is separately bounded (~10s — DEFAULT_FLUSH_TIMEOUT_MS
 * in langfuseClient.ts), plus a fixed buffer for the fast, local (IndexedDB)
 * bookkeeping around them. This used to be a flat 5 minutes, unrelated to how
 * long the guarded call could actually take — a slow local model legitimately
 * exceeding 5 minutes would expire the lock while the first dreamer was still
 * working, letting a SECOND one start concurrently (the exact interleaving
 * this lock exists to prevent). Tying the TTL to the same ceiling as the
 * call it guards means expiry now really does mean the holder crashed (the
 * service worker was killed, per MV3's own rules) mid-dream, not merely that
 * it's still working.
 */
export const DREAM_LOCK_TTL_MS = DREAM_MODEL_TIMEOUT_MS + 60_000

const VALID_KINDS: MemoryKind[] = ['fact', 'preference', 'project', 'summary']
const MAX_ADDS_PER_DREAM = 12
export const MAX_MEMORY_CHARS = 600
const MAX_MESSAGE_CHARS = 1_500
export const MAX_TRANSCRIPT_CHARS = 24_000
// A hard ceiling on how many unconsolidated episodes one cycle will even look
// at (oldest first — listUnconsolidatedEpisodes sorts ascending by
// startedAt). Without this, a backlog that grows because the dream model
// keeps failing to produce parseable output (see PARSE_FAILURE_WARNING_THRESHOLD
// below) would make every future attempt's bookkeeping scale with the whole
// backlog forever.
const MAX_EPISODES_PER_DREAM = 500
// After this many consecutive unparseable-output cycles, the skipped reason
// says so explicitly instead of the same generic "will retry next cycle" —
// the backlog is still bounded (MAX_EPISODES_PER_DREAM) either way, but a
// silently-stuck dreaming model deserves a louder signal in the Memory panel.
const PARSE_FAILURE_WARNING_THRESHOLD = 3

/**
 * Alarm entry point: dream only when due and the user has gone quiet.
 *
 * With a `dispatch`, this is everything the service worker does at the start of
 * a cycle — read the gates, take the lock, hand the job off — and it returns the
 * moment the hand-off is accepted. It deliberately does NOT await the cycle:
 * awaiting would keep the worker's alarm handler open across a whole generation,
 * which is precisely what Chrome kills (see the header). The result comes back
 * as its own message, and completeDispatchedDream finishes the job.
 *
 * Without one, it runs both halves here, which is only correct in a realm that
 * can afford a slow fetch (the panel, or a test).
 */
export async function dreamIfDue(dispatch?: DreamDispatch): Promise<DreamOutcome> {
  const settings = await loadSettings()
  const state = await getDreamState()
  const episodes = await listUnconsolidatedEpisodes()
  const due = evaluateDreamDue({
    lastDreamAt: state.lastDreamAt,
    episodes,
    intervalMs: resolveDreamIntervalMs(settings),
    now: Date.now(),
  })
  if (!due.due) return { status: 'skipped', reason: due.reason }
  if (!dispatch) return runDream(settings)

  const selected = getDreamProvider(settings)
  if (!selected) return { status: 'skipped', reason: 'No model configured.' }
  const token = await acquireDreamLock()
  if (!token) return { status: 'skipped', reason: 'Another dream cycle is already in progress.' }
  try {
    await dispatch(jobFor(settings, selected), token)
    return { status: 'dispatched' }
  } catch (err) {
    // The lock is released HERE and not left to expire: a hand-off that failed
    // in a millisecond (no offscreen document, a torn-down worker) would
    // otherwise hold the lock for the whole DREAM_LOCK_TTL_MS and block every
    // retry — including the user's own "Dream now" — for ~16 minutes.
    await releaseDreamLock(token)
    const reason = err instanceof Error ? err.message : String(err)
    return { status: 'skipped', reason: `Could not start the dream host (${reason}); will retry next cycle.` }
  }
}

/** The job a resolved provider + settings imply. */
function jobFor(settings: Settings, selected: { provider: ProviderConfig; modelId: string }): DreamJob {
  return {
    provider: selected.provider,
    modelId: selected.modelId,
    observability: observabilityConfig(settings),
  }
}

export interface DreamDueInput {
  lastDreamAt: number | null
  episodes: Pick<EpisodeRecord, 'updatedAt'>[]
  intervalMs: number
  now: number
}

export type DreamDueResult = { due: true } | { due: false; reason: string }

/**
 * Pure "is it time to dream" predicate, extracted out of dreamIfDue so every
 * timing edge case (first run, clock skew, a zero/huge interval, no episodes,
 * the idle guard, a pathologically large backlog) is directly testable
 * without touching storage. Order matters: the interval check runs before the
 * episode/idle checks, matching the original behavior — a too-recent last
 * dream skips before anything else is even considered.
 */
export function evaluateDreamDue(input: DreamDueInput): DreamDueResult {
  const { lastDreamAt, episodes, intervalMs, now } = input
  const skewedIntoFuture = lastDreamAt !== null && lastDreamAt - now > CLOCK_SKEW_TOLERANCE_MS
  const effectiveLastDreamAt = skewedIntoFuture ? null : lastDreamAt
  if (effectiveLastDreamAt !== null && now - effectiveLastDreamAt < intervalMs) {
    return { due: false, reason: 'Dreamed recently.' }
  }
  if (episodes.length === 0) return { due: false, reason: 'Nothing new to consolidate.' }
  // A reduce, not Math.max(...spread): an array of tens of thousands of
  // episodes (an unbounded backlog left by a persistently-broken dream model)
  // would otherwise risk "RangeError: Maximum call stack size exceeded" on the
  // spread — thrown from an alarm handler, that would silently and
  // permanently stop dreaming from ever running again.
  const lastActivity = episodes.reduce((max, e) => Math.max(max, e.updatedAt), 0)
  if (now - lastActivity < MIN_IDLE_MS) {
    return { due: false, reason: 'User is still active.' }
  }
  return { due: true }
}

/**
 * Runs one full dream cycle immediately (used by the "Dream now" button and the
 * due-check above). Ignores the interval/idle gates — the caller decides when.
 * `preloaded` lets `dreamIfDue` avoid re-reading settings it just loaded.
 *
 * Reentrancy: dream.ts runs in two independent JS realms that share no
 * in-memory state — the service worker's alarm and the side panel's "Dream
 * now" — and the service worker can be killed and restarted by MV3 at any
 * point, including mid-dream. An in-memory flag would only ever guard calls
 * within the realm that set it, and would vanish on a service-worker restart
 * anyway, so the mutex here is backed by chrome.storage.local (visible to
 * both realms, and outlives a service-worker restart) instead — see
 * acquireDreamLock/releaseDreamLock.
 */
export async function runDream(preloaded?: Settings): Promise<DreamOutcome> {
  const settings = preloaded ?? (await loadSettings())
  const selected = getDreamProvider(settings)
  if (!selected) return { status: 'skipped', reason: 'No model configured.' }

  const token = await acquireDreamLock()
  if (!token) return { status: 'skipped', reason: 'Another dream cycle is already in progress.' }

  try {
    return await settleDreamCycle(await runDreamCycle(jobFor(settings, selected)))
  } finally {
    await releaseDreamLock(token)
  }
}

/**
 * The half that does the work: one model call plus the IndexedDB reads and
 * writes around it. Runs wherever the caller says — the offscreen host for the
 * alarm's cycle, the side panel for "Dream now".
 *
 * **Touches no `chrome.*` API.** That is a requirement, not an observation: an
 * offscreen document only gets `chrome.runtime`, so a stray chrome.storage read
 * on this path is a crash there and nowhere else. Everything storage-shaped
 * (settings, dream state, the lock) is resolved by the caller and arrives in the
 * `job`; everything this learns leaves as a return value for the caller to
 * persist. IndexedDB is a Web API available in every realm, so the memory and
 * episode stores are read and written here directly.
 *
 * Assumes the caller already holds the dream lock.
 */
export async function runDreamCycle(job: DreamJob): Promise<DreamCycleResult> {
  // Listed only AFTER the lock is held (the caller's job), not before: a
  // concurrent cycle that started first may have already consolidated
  // everything by the time this one gets in, and re-checking here (rather than
  // trusting a pre-lock read) is what makes the "no lost/duplicated memories"
  // guarantee real instead of merely probable.
  const pending = await listUnconsolidatedEpisodes()
  if (pending.length === 0) return { kind: 'nothing' }
  const episodes = pending.slice(0, MAX_EPISODES_PER_DREAM)
  const memories = await listMemories()

  // Observability: the dream is a single generation, in its own trace (no chat
  // session — nobody is watching this happen).
  const observer = getObserver(job.observability)
  const trace = observer.enabled ? observer.startTrace({ name: 'dream', tags: ['dreaming'] }) : undefined
  const prompt = buildDreamPrompt(memories, episodes)
  const gen = trace?.generation({ name: 'dream', model: job.modelId, input: prompt })

  let text: string
  try {
    const res = await generateText({
      model: createModel(job.provider, job.modelId),
      // v7 renamed `system` to `instructions` (`system` still works, deprecated).
      instructions: DREAM_SYSTEM_PROMPT,
      prompt,
      // See DREAM_MODEL_TIMEOUT_MS: without this, a hung socket keeps the
      // caller's lock held indefinitely (no error ever reaches its finally to
      // release it), and nothing but the TTL fallback could ever reclaim it.
      // Only here is that 15-minute ceiling reachable at all — in the service
      // worker Chrome ended the whole cycle at ~5 minutes regardless.
      abortSignal: AbortSignal.timeout(DREAM_MODEL_TIMEOUT_MS),
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
    return { kind: 'unparseable', episodes: episodes.length }
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

  trace?.end({
    output: ops.daySummary ?? undefined,
    metadata: { added, updated, deleted, episodes: episodes.length },
  })
  await observer.flush()

  return { kind: 'consolidated', added, updated, deleted, episodes: episodes.length, summary: ops.daySummary }
}

/**
 * The half that records what happened: dream state (chrome.storage) and the
 * user-facing wording. Split out of the cycle so the counter behind
 * PARSE_FAILURE_WARNING_THRESHOLD still exists for a cycle that ran in a realm
 * with no storage to count in.
 */
async function settleDreamCycle(result: DreamCycleResult): Promise<DreamOutcome> {
  if (result.kind === 'nothing') return { status: 'skipped', reason: 'Nothing new to consolidate.' }
  if (result.kind === 'unparseable') {
    const state = await getDreamState()
    const failures = (state.consecutiveParseFailures ?? 0) + 1
    await setDreamState({ ...state, consecutiveParseFailures: failures })
    const reason =
      failures >= PARSE_FAILURE_WARNING_THRESHOLD
        ? `Model returned unparseable output ${failures} times in a row — check your dreaming model. Still retrying (oldest ${result.episodes} conversation${result.episodes === 1 ? '' : 's'} pending).`
        : 'Model returned unparseable output; will retry next cycle.'
    return { status: 'skipped', reason }
  }
  await setDreamState({ lastDreamAt: Date.now(), lastSummary: result.summary, consecutiveParseFailures: 0 })
  return {
    status: 'dreamed',
    added: result.added,
    updated: result.updated,
    deleted: result.deleted,
    episodes: result.episodes,
    summary: result.summary,
  }
}

/**
 * Finish a cycle that ran somewhere else: record it, then release the lock the
 * dispatching realm took on its behalf. Called from the service worker when the
 * offscreen host's result arrives — possibly the very event that revived the
 * worker, since it was free to be killed while the host worked.
 *
 * The release sits in a `finally` for the same reason runDream's does: a storage
 * hiccup while recording must not strand the lock, or dreaming stops for the
 * rest of the TTL over something that changed nothing.
 */
export async function completeDispatchedDream(result: DreamCycleResult, token: string): Promise<DreamOutcome> {
  try {
    return await settleDreamCycle(result)
  } finally {
    await releaseDreamLock(token)
  }
}

/**
 * A dispatched cycle that will never produce a result (the host reported a
 * failed generation): drop its lock so the next tick can retry at once instead
 * of waiting out DREAM_LOCK_TTL_MS.
 */
export async function abandonDispatchedDream(token: string): Promise<void> {
  await releaseDreamLock(token)
}

// ---------------------------------------------------------------------------
// Reentrancy lock (chrome.storage.local-backed — see runDream's doc comment).
// Exported for direct testing of the mutex mechanics (staleness, clock skew,
// cross-instance durability) without needing to drive a full dream cycle for
// every scenario — same reasoning as exporting buildDreamPrompt/parseDreamOps
// below.
// ---------------------------------------------------------------------------

/**
 * Try to become the sole dreamer. Mirrors src/data/settings.ts's
 * migrateSecretsToSealed: write a token, then re-read to catch another
 * acquirer who wrote in the same tick — chrome.storage has no real
 * compare-and-swap, so a one-microtask race window remains (same accepted
 * tradeoff as that guard). Returns the token to hold (pass to
 * releaseDreamLock), or null if someone else holds a live lock.
 */
export async function acquireDreamLock(): Promise<string | null> {
  const existing = await getDreamLock()
  if (existing && !isLockStale(existing, Date.now())) return null
  const token = crypto.randomUUID()
  await setDreamLock({ token, acquiredAt: Date.now() })
  const after = await getDreamLock()
  return after?.token === token ? token : null
}

/**
 * A lock is stale — abandoned by a holder that crashed mid-dream, or written
 * under a clock that has since jumped backward — once it's older than the
 * TTL, or, symmetrically, if its own timestamp is implausibly far in the
 * future (see CLOCK_SKEW_TOLERANCE_MS).
 */
function isLockStale(lock: { acquiredAt: number }, now: number): boolean {
  const age = now - lock.acquiredAt
  if (age < -CLOCK_SKEW_TOLERANCE_MS) return true
  return age > DREAM_LOCK_TTL_MS
}

/**
 * Release, but only if the lock is still the one this call acquired — a lock
 * this call lost (it went stale and someone else reclaimed it) must not be
 * torn out from under that new holder.
 */
export async function releaseDreamLock(token: string): Promise<void> {
  const current = await getDreamLock()
  if (current?.token === token) await clearDreamLock()
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

/**
 * Builds the dream prompt, keeping the whole transcript section within
 * MAX_TRANSCRIPT_CHARS: each episode block is truncated to whatever budget
 * remains before being appended, rather than appended whole-or-not-at-all — a
 * single very long episode (a power-user's hour-long, many-turn session)
 * would otherwise blow far past the nominal budget on its own, since checking
 * the budget only BEFORE adding a block (the original code) never accounts
 * for that block's own size.
 */
export function buildDreamPrompt(memories: MemoryRecord[], episodes: EpisodeRecord[]): string {
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
    let block = `### Conversation (${new Date(e.startedAt).toISOString()})\n${lines.join('\n')}`
    if (block.length > budget) block = `${block.slice(0, budget)} […]`
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

export interface DreamOps {
  add: Array<{ kind: MemoryKind; content: string; tags: string[] }>
  update: Array<{ id: string; patch: { content?: string; tags?: string[] } }>
  delete: string[]
  daySummary: string | null
}

export function parseDreamOps(text: string): DreamOps | null {
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
