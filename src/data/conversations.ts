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

const DB_NAME = 'lychee-conversations'
const DB_VERSION = 2
const STORE = 'conversations'
const SUMMARY_STORE = 'summaries'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (event) => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
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
): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE, SUMMARY_STORE], 'readwrite')
        const store = tx.objectStore(STORE)
        const read = store.get(id) as IDBRequest<StoredConversation | undefined>
        read.onsuccess = () => {
          const next = fn(read.result)
          store.put(next)
          tx.objectStore(SUMMARY_STORE).put(toSummaryRow(next))
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
  }))
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
    const tx = db.transaction([STORE, SUMMARY_STORE], 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.objectStore(SUMMARY_STORE).delete(id)
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
    const tx = db.transaction([STORE, SUMMARY_STORE], 'readwrite')
    tx.objectStore(STORE).clear()
    tx.objectStore(SUMMARY_STORE).clear()
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
