// Persisted chat history, housed in its own IndexedDB database (extension
// origin). Each conversation stores both the UI-facing transcript (so it can be
// rendered on reopen) and the model-facing history (so the agent can continue
// it). Kept separate from the memory/episode DB in memory.ts so neither module
// has to coordinate schema versions with the other.
//
// A second, lightweight `summaries` object store mirrors the history-dropdown's
// 5 scalar fields (+ a byte estimate) for every row, written inside the SAME
// transaction as the full record. listConversations/conversationsUsage read
// ONLY this store: they used to getAll() the full store — every messages[]/
// history[] transcript deserialized just to project a handful of scalars — a
// cost that scales with an install's entire lifetime of chat data and was paid
// on every single turn (Chat.tsx refreshes the list after every save).

import type { ModelMessage } from 'ai'
import type { MessageSource, UIMessage } from '../agent/agent'
import { estimateBytes, type StoreUsage } from './usage'

/**
 * Everything needed to re-run the most recent turn from scratch, behind the
 * Regenerate button under the last reply. Captured when a continuation chain
 * starts rather than reconstructed from `history` at click time, because a
 * failed chain pops its own user message back off history (see runTurnChain's
 * catch) — after exactly the failure the user most wants to retry, history no
 * longer holds the message to replay. Persisted with the conversation so the
 * button survives a side-panel reopen.
 */
export interface RegenTarget {
  /** `history` length before the chain pushed anything — its rollback point. */
  historyLen: number
  /** The user message that opened the chain; null for a resumed checkpoint. */
  opener: ModelMessage | null
  /** id of the first UI bubble the chain created; the transcript cuts here. */
  firstBubbleId: string
  /** The chain's context, replayed verbatim (see runTurnChain's ctx). */
  attachedSources: MessageSource[]
  activeSkill: { name: string; body: string } | null
  journalUserText: string
  droppableTail: boolean
  /** Tools pre-authorized for the turn (e.g. @memory → SearchMemory). */
  allowed: string[]
}

export interface StoredConversation {
  id: string
  /** Null until the auto-namer has produced a title. */
  title: string | null
  createdAt: number
  updatedAt: number
  messages: UIMessage[]
  history: ModelMessage[]
  /** Pinned conversations sort first in the Library. Absent means false. */
  pinned?: boolean
  /** Undo point for the last turn. Absent on chats saved before this existed
   *  (and on any whose last turn predates it) — Regenerate is simply not
   *  offered until their next turn writes one. */
  regen?: RegenTarget
}

/** Lightweight row for the history dropdown (no message bodies). */
export interface ConversationSummary {
  id: string
  title: string | null
  createdAt: number
  updatedAt: number
  messageCount: number
  pinned?: boolean
}

/** Row shape of the `summaries` store: the list projection plus a byte
 *  estimate, computed once at write time so conversationsUsage never has to
 *  touch the heavy store either. */
interface SummaryRow extends ConversationSummary {
  bytes: number
}

function toSummaryRow(c: StoredConversation): SummaryRow {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    // Defensive: a pre-existing row from an earlier release, a manual
    // devtools edit, or a partial write could have a missing/non-array
    // `messages` — never trust it blindly during backfill (belt-and-
    // suspenders alongside the try/catch around this function's call site
    // in openDb()'s cursor handler below).
    messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
    pinned: c.pinned ?? false,
    bytes: estimateBytes(c),
  }
}

/**
 * Stand-in summary for a pre-existing row that failed to project during
 * backfill (see the cursor handler in openDb() below). Keyed by the row's own
 * primary key so it stays LISTED — never silently dropped — while every other
 * field is an honest, unmistakable placeholder rather than fabricated data.
 * The real record in `conversations` is untouched, so the conversation can
 * still be opened normally; only its list projection is degraded.
 */
function degradedSummaryRow(id: string): SummaryRow {
  return { id, title: '(unreadable conversation)', createdAt: 0, updatedAt: 0, messageCount: 0, pinned: false, bytes: 0 }
}

/**
 * A turn caught mid-flight, so closing the side panel does not destroy it.
 *
 * The panel persists a transcript only when a turn *finishes* — so closing it
 * during a long multi-tool turn used to lose the reply AND the user's own
 * message. This is the checkpoint that survives that, written on a debounce
 * while the turn streams and deleted in the same transaction as the final save.
 *
 * Everything here is what `runTurnChain` needs to pick the turn back up. Three
 * things are deliberately ABSENT, and their absence is the safety property:
 *
 *  - **No page-control grant.** The session is origin- and tab-fenced against a
 *    page that has almost certainly changed by the time anyone resumes; a
 *    resumed turn must ask for control again through a fresh card.
 *  - **No image queue.** Its pixels describe a page state that no longer exists.
 *  - **No pending approval.** The chain's teardown already denied it.
 */
export interface InFlightTurn {
  conversationId: string
  startedAt: number
  /** Last checkpoint write; drives staleness (see `sweepInFlight`). */
  updatedAt: number
  /** The transcript including the partially-streamed assistant bubble. */
  messages: UIMessage[]
  /** Model-facing history, dehydrated exactly like a saved conversation's. */
  history: ModelMessage[]
  /** `runTurnChain`'s own ctx argument, replayed verbatim on resume. */
  ctx: {
    attachedSources: MessageSource[]
    activeSkill: { name: string; body: string } | null
    journalUserText: string
    droppableTail: boolean
    regen: RegenTarget | null
  }
  /** Progressive-disclosure set, so a resumed turn keeps its loaded tools. */
  activeNames: string[]
  autoContinues: number
  episodeId: string
  /** Bubble the cycle was streaming into, so resume patches the same one. */
  assistantId: string
}

const DB_NAME = 'lychee-conversations'
const DB_VERSION = 3
const STORE = 'conversations'
const SUMMARY_STORE = 'summaries'
const INFLIGHT_STORE = 'inflight'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (event) => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
        // v3. Nothing to backfill: "no turn was in flight" is the correct state
        // for every conversation that existed before this store did.
        if (!db.objectStoreNames.contains(INFLIGHT_STORE)) {
          db.createObjectStore(INFLIGHT_STORE, { keyPath: 'conversationId' })
        }
        if (!db.objectStoreNames.contains(SUMMARY_STORE)) {
          const summaryStore = db.createObjectStore(SUMMARY_STORE, { keyPath: 'id' })
          // Upgrading an install that already has conversations (oldVersion >
          // 0, i.e. not a brand-new empty DB): seed a summary for each
          // existing row now, in this same versionchange transaction, so
          // listConversations never has to fall back to the heavy store.
          if (event.oldVersion > 0) {
            const tx = req.transaction
            const cursorReq = tx?.objectStore(STORE).openCursor()
            if (cursorReq) {
              cursorReq.onsuccess = () => {
                const cursor = cursorReq.result
                if (!cursor) return
                // A single bad row must never take down this whole upgrade.
                // Per the IndexedDB spec, an uncaught exception thrown from a
                // request's onsuccess handler aborts the ENTIRE versionchange
                // transaction — rolling back both the summaries-store
                // creation and the version bump together. Left uncaught,
                // every subsequent openDb() would retry the identical
                // upgrade, hit the identical bad row, and abort again: the
                // database stuck at v1 forever, and every operation that
                // assumes `summaries` exists (list/save/rename/pin/delete/
                // clear) broken permanently with no in-app recovery. Skip
                // the failing projection and degrade instead — reading
                // `cursor.value`/`toSummaryRow` never mutates or deletes the
                // original `conversations` row, only this store's put does.
                try {
                  summaryStore.put(toSummaryRow(cursor.value as StoredConversation))
                } catch (err) {
                  console.error(
                    '[conversations] malformed row during summaries backfill — degrading it instead of aborting the upgrade',
                    cursor.primaryKey,
                    err,
                  )
                  summaryStore.put(degradedSummaryRow(String(cursor.primaryKey)))
                }
                cursor.continue()
              }
            }
          }
        }
      }
      req.onsuccess = () => {
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

function requestOn<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(store, mode).objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

const requestOf = <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
  requestOn(STORE, mode, fn)

export async function getConversation(id: string): Promise<StoredConversation | null> {
  const rec = await requestOf<StoredConversation | undefined>('readonly', (s) => s.get(id))
  return rec ?? null
}

/**
 * Pinned rows first, then most-recently-updated first within each group. Pure
 * so it can be unit-tested without the IndexedDB plumbing around it.
 */
export function comparePinnedThenRecent(
  a: Pick<ConversationSummary, 'pinned' | 'updatedAt'>,
  b: Pick<ConversationSummary, 'pinned' | 'updatedAt'>,
): number {
  return Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.updatedAt - a.updatedAt
}

/** Lightweight list for the history dropdown — reads only the `summaries`
 *  store; never touches a messages[]/history[] transcript. */
export async function listConversations(): Promise<ConversationSummary[]> {
  const all = await requestOn<SummaryRow[]>(SUMMARY_STORE, 'readonly', (s) => s.getAll())
  return all
    .map(({ bytes: _bytes, ...summary }) => summary)
    .sort(comparePinnedThenRecent)
}

/**
 * Read-modify-write a row inside ONE readwrite transaction spanning both
 * stores — the full record and its summary must land together, or a crash mid
 * write could leave listConversations permanently out of sync with the real
 * transcript.
 *
 * The read and the write must not be separate transactions: the transcript save
 * and the auto-namer both land at the end of a turn and each rewrites the whole
 * record, so a `get` in one transaction and a `put` in another interleave into a
 * lost update — the namer's title is overwritten by a save that had already read
 * the row as untitled, or the save's transcript is overwritten by the namer's
 * empty stub. IndexedDB serialises overlapping readwrite transactions on a store,
 * so keeping both halves in one makes the update atomic.
 */
function mutate(
  id: string,
  fn: (existing: StoredConversation | undefined) => StoredConversation,
  /**
   * Also drop this conversation's in-flight checkpoint, inside the SAME
   * transaction as the record write. Set only by `saveConversation`, which runs
   * when a turn has genuinely finished.
   *
   * Two separate transactions would not do: a crash between them leaves either
   * a resume card for a turn that already completed (the user re-runs finished
   * work) or a saved transcript with its checkpoint still live. Riding the
   * record's own transaction makes "the turn is done" and "there is nothing to
   * resume" a single atomic fact.
   *
   * Deliberately NOT set by `renameConversation`/`togglePin`: the auto-namer
   * fires while a turn is still streaming, so clearing there would delete the
   * checkpoint of a turn that is still running.
   */
  alsoClearInFlight = false,
): Promise<void> {
  const stores = alsoClearInFlight ? [STORE, SUMMARY_STORE, INFLIGHT_STORE] : [STORE, SUMMARY_STORE]
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(stores, 'readwrite')
        const store = tx.objectStore(STORE)
        const read = store.get(id) as IDBRequest<StoredConversation | undefined>
        read.onsuccess = () => {
          const next = fn(read.result)
          store.put(next)
          tx.objectStore(SUMMARY_STORE).put(toSummaryRow(next))
          if (alsoClearInFlight) tx.objectStore(INFLIGHT_STORE).delete(id)
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

/** Upsert the transcript, preserving an existing title and createdAt. */
export async function saveConversation(input: {
  id: string
  messages: UIMessage[]
  history: ModelMessage[]
  regen?: RegenTarget
}): Promise<void> {
  const now = Date.now()
  await mutate(input.id, (existing) => ({
    id: input.id,
    title: existing?.title ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messages: input.messages,
    history: input.history,
    // saveConversation rebuilds the record field-by-field (no `...existing`
    // spread), so the pin must be carried forward explicitly or every
    // transcript save would silently unpin the conversation.
    pinned: existing?.pinned ?? false,
    // Likewise the undo point: a save that can't name one (an older chat whose
    // last turn predates the field) must leave the stored one alone rather
    // than retire a Regenerate button that still works.
    regen: input.regen ?? existing?.regen,
  }), true)
}

/** Set the title, creating a stub row if the transcript hasn't saved yet. */
export async function renameConversation(id: string, title: string): Promise<void> {
  const now = Date.now()
  await mutate(id, (existing) =>
    existing
      ? { ...existing, title }
      : { id, title, createdAt: now, updatedAt: now, messages: [], history: [] },
  )
}

/** Flip the pinned flag, creating a stub row if the transcript hasn't saved yet. */
export async function togglePin(id: string): Promise<void> {
  const now = Date.now()
  await mutate(id, (existing) =>
    existing
      ? { ...existing, pinned: !(existing.pinned ?? false) }
      : { id, title: null, createdAt: now, updatedAt: now, messages: [], history: [], pinned: true },
  )
}

/** Deletes both the full record and its summary — leaving the latter behind
 *  would show a phantom "deleted" conversation in the history dropdown forever. */
export async function deleteConversation(id: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, SUMMARY_STORE, INFLIGHT_STORE], 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.objectStore(SUMMARY_STORE).delete(id)
    // A checkpoint outliving its conversation would be unreachable but not
    // harmless: nothing would ever clear it, and it holds a whole transcript.
    tx.objectStore(INFLIGHT_STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/**
 * Wipe every stored conversation. Screenshots are keyed by conversation but live
 * in their own database, so the caller (`storage.ts`) clears them alongside.
 */
export async function clearConversations(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, SUMMARY_STORE, INFLIGHT_STORE], 'readwrite')
    tx.objectStore(STORE).clear()
    tx.objectStore(SUMMARY_STORE).clear()
    tx.objectStore(INFLIGHT_STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/**
 * Checkpoint a turn that is still streaming. Called on a debounce, so it must
 * stay a single cheap `put` — no read-modify-write, no summary maintenance.
 */
export async function saveInFlight(record: InFlightTurn): Promise<void> {
  await requestOn<IDBValidKey>(INFLIGHT_STORE, 'readwrite', (s) => s.put(record))
}

/** The checkpoint for a conversation, if a turn was interrupted mid-flight. */
export async function getInFlight(conversationId: string): Promise<InFlightTurn | undefined> {
  return requestOn<InFlightTurn | undefined>(INFLIGHT_STORE, 'readonly', (s) =>
    s.get(conversationId),
  )
}

/** Discard a checkpoint — the user declined to resume, or the turn ended. */
export async function clearInFlight(conversationId: string): Promise<void> {
  await requestOn<undefined>(INFLIGHT_STORE, 'readwrite', (s) => s.delete(conversationId))
}

/**
 * Drop checkpoints older than `maxAgeMs`. A turn interrupted last month is not
 * something the user wants offered back to them, and each record holds a whole
 * transcript — so without a sweep, an install that crashes occasionally
 * accumulates them silently forever.
 */
export async function sweepInFlight(maxAgeMs: number): Promise<void> {
  const all = await requestOn<InFlightTurn[]>(INFLIGHT_STORE, 'readonly', (s) => s.getAll())
  const cutoff = Date.now() - maxAgeMs
  const stale = all.filter((r) => r.updatedAt < cutoff)
  if (stale.length === 0) return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(INFLIGHT_STORE, 'readwrite')
    const store = tx.objectStore(INFLIGHT_STORE)
    for (const r of stale) store.delete(r.conversationId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/** Byte/row estimate for the Data tab — reads only the `summaries` store. */
export async function conversationsUsage(): Promise<StoreUsage> {
  const all = await requestOn<SummaryRow[]>(SUMMARY_STORE, 'readonly', (s) => s.getAll())
  return {
    bytes: all.reduce((n, s) => n + s.bytes, 0),
    count: all.length,
    detail: all.length === 1 ? '1 chat' : `${all.length} chats`,
  }
}

/** Test-only: close and delete the underlying database so the next call opens
 *  a fresh one — lets a migration test start from a specific schema version.
 *  Mirrors vault.ts's resetVault. */
export async function _resetDbForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null)
    db?.close()
  }
  dbPromise = null
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}
