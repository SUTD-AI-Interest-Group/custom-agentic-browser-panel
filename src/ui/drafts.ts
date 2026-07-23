// Per-conversation composer draft persistence, so a half-typed message
// survives switching chats or closing the panel entirely (chrome.storage.local,
// unlike component state, outlives the side panel closing). Writes are
// debounced so a fast typist doesn't hammer storage on every keystroke — only
// the last call within the debounce window actually hits disk.

const DEBOUNCE_MS = 400

/** The chrome.storage.local key a conversation's draft is stored under.
 *  Exported so its shape (and only its shape) is unit-testable without chrome. */
export function draftKey(conversationId: string): string {
  return `draft:${conversationId}`
}

// One pending debounce timer per conversation id. A module-level map (not a
// ref) because a fresh Chat mount per conversation switch must not cancel a
// still-pending write that belongs to the chat just left.
const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** Load a conversation's saved draft, or '' if none is stored. */
export async function loadDraft(conversationId: string): Promise<string> {
  const key = draftKey(conversationId)
  const data = await chrome.storage.local.get(key)
  const value = data[key]
  return typeof value === 'string' ? value : ''
}

/** Debounced (~400ms) write of a conversation's draft text. Rapid keystrokes
 *  coalesce into one write per pause — each call resets the same key's timer. */
export function saveDraft(conversationId: string, text: string): void {
  const key = draftKey(conversationId)
  const pending = timers.get(key)
  if (pending) clearTimeout(pending)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      void chrome.storage.local.set({ [key]: text })
    }, DEBOUNCE_MS),
  )
}

/** Remove a conversation's saved draft (called once a message actually sends)
 *  and cancel any still-pending debounced write so it can't resurrect the old
 *  text after the fact. */
export async function clearDraft(conversationId: string): Promise<void> {
  const key = draftKey(conversationId)
  const pending = timers.get(key)
  if (pending) {
    clearTimeout(pending)
    timers.delete(key)
  }
  await chrome.storage.local.remove(key)
}
