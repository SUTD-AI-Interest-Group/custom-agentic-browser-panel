// Persisted chat history, housed in its own IndexedDB database (extension
// origin). Each conversation stores both the UI-facing transcript (so it can be
// rendered on reopen) and the model-facing history (so the agent can continue
// it). Kept separate from the memory/episode DB in memory.ts so neither module
// has to coordinate schema versions with the other.

import type { ModelMessage } from 'ai'
import type { UIMessage } from '../agent/agent'
import { estimateBytes, type StoreUsage } from './usage'

export interface StoredConversation {
  id: string
  /** Null until the auto-namer has produced a title. */
  title: string | null
  createdAt: number
  updatedAt: number
  messages: UIMessage[]
  history: ModelMessage[]
}

/** Lightweight row for the history dropdown (no message bodies). */
export interface ConversationSummary {
  id: string
  title: string | null
  createdAt: number
  updatedAt: number
  messageCount: number
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

export async function listConversations(): Promise<ConversationSummary[]> {
  const all = await requestOf<StoredConversation[]>('readonly', (s) => s.getAll())
  return all
    .map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Upsert the transcript, preserving an existing title and createdAt. */
export async function saveConversation(input: {
  id: string
  messages: UIMessage[]
  history: ModelMessage[]
}): Promise<void> {
  const existing = await getConversation(input.id)
  const now = Date.now()
  const record: StoredConversation = {
    id: input.id,
    title: existing?.title ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messages: input.messages,
    history: input.history,
  }
  await requestOf('readwrite', (s) => s.put(record))
}

/** Set the title, creating a stub row if the transcript hasn't saved yet. */
export async function renameConversation(id: string, title: string): Promise<void> {
  const existing = await getConversation(id)
  const now = Date.now()
  const record: StoredConversation = existing
    ? { ...existing, title }
    : { id, title, createdAt: now, updatedAt: now, messages: [], history: [] }
  await requestOf('readwrite', (s) => s.put(record))
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
