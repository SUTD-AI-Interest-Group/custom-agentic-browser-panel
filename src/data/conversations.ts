// Persisted chat history, housed in its own IndexedDB database (extension
// origin). Each conversation stores both the UI-facing transcript (so it can be
// rendered on reopen) and the model-facing history (so the agent can continue
// it). Kept separate from the memory/episode DB in memory.ts so neither module
// has to coordinate schema versions with the other.

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

const DB_NAME = 'lychee-conversations'
const DB_VERSION = 1
const STORE = 'conversations'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
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

function requestOf<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

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

export async function listConversations(): Promise<ConversationSummary[]> {
  const all = await requestOf<StoredConversation[]>('readonly', (s) => s.getAll())
  return all
    .map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
      pinned: c.pinned ?? false,
    }))
    .sort(comparePinnedThenRecent)
}

/**
 * Read-modify-write a row inside ONE readwrite transaction.
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
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        const read = store.get(id) as IDBRequest<StoredConversation | undefined>
        read.onsuccess = () => store.put(fn(read.result))
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

export async function deleteConversation(id: string): Promise<void> {
  await requestOf('readwrite', (s) => s.delete(id))
}

/**
 * Wipe every stored conversation. Screenshots are keyed by conversation but live
 * in their own database, so the caller (`storage.ts`) clears them alongside.
 */
export async function clearConversations(): Promise<void> {
  await requestOf('readwrite', (s) => s.clear())
}

/** Byte/row estimate for the Data tab. */
export async function conversationsUsage(): Promise<StoreUsage> {
  const all = await requestOf<StoredConversation[]>('readonly', (s) => s.getAll())
  return {
    bytes: estimateBytes(all),
    count: all.length,
    detail: all.length === 1 ? '1 chat' : `${all.length} chats`,
  }
}
