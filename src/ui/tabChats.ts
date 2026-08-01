// Which chat belongs to which tab. A chat is bound to a tab id *and* the origin
// that tab was on when it was bound: switching tabs, or navigating the bound tab
// to another site, gives you a fresh chat, while navigating within the same site
// keeps the one you were using.
//
// The map is mirrored to chrome.storage.session rather than .local on purpose —
// that area is wiped on browser restart, which is exactly when tab ids stop
// meaning anything. The keys and the thing they key expire together, so a stale
// map can never point a reopened panel at some unrelated tab. It does survive the
// side panel closing and reopening mid-session, which is the case that matters.

/** Everything the panel remembers about one tab's chat. */
export interface TabBinding {
  conversationId: string
  originKey: string
  /** When this tab last claimed the conversation; disambiguates the reverse
   *  lookup when two tabs point at the same chat (see boundTabFor). */
  boundAt: number
}

export type TabChatMap = Record<number, TabBinding>

/**
 * What a mounted chat is doing, reported up to App.
 * - `running`  — a continuation chain is streaming
 * - `parked`   — stopped at a step that needs its tab in front (see agent.ts)
 * - `needs-you`— blocked on an approval card the user hasn't answered
 * - `idle`     — nothing in flight
 */
export type ChatStatus = 'idle' | 'running' | 'parked' | 'needs-you'

/** A chat in any of these states must stay mounted even when it isn't visible. */
export function isLive(status: ChatStatus): boolean {
  return status !== 'idle'
}

/**
 * Is this chat blocked on the user rather than working?
 *
 * Announced on *state* rather than on the transition into it, unlike a finished
 * turn. A turn can only finish once, but a chat can be left waiting two ways:
 * the card appears while the user is elsewhere (a transition), or it appears
 * while they are watching and they then switch away (no transition at all). Only
 * the state test catches both, and the second is the easier one to walk into.
 */
export function needsAttention(status: ChatStatus): boolean {
  return status === 'needs-you' || status === 'parked'
}

/**
 * The identity a chat is bound to: scheme + host.
 *
 * Not `URL.origin`, which collapses to the string "null" for the opaque-origin
 * schemes a browser extension actually meets (`about:`, `data:`, `file:`) — every
 * local file would then share one chat. When there is no host to key on we fall
 * back to the whole URL, so those pages each get their own chat instead.
 */
export function originKey(url: string): string {
  const raw = (url ?? '').trim()
  if (!raw) return ''
  try {
    const u = new URL(raw)
    return u.host ? `${u.protocol}//${u.host}` : raw
  } catch {
    // Not a parseable URL (rare, but tab.url can be '' or a truncated value on a
    // tab that hasn't committed a navigation yet) — key on it verbatim.
    return raw
  }
}

export type BindingResolution =
  | { kind: 'existing'; conversationId: string }
  | { kind: 'fresh' }

/**
 * Which chat a tab should show. `existing` only when this tab has a binding AND
 * it is still on the origin that binding was made against — a cross-origin
 * navigation is treated exactly like switching to a new tab.
 */
export function resolveBinding(map: TabChatMap, tabId: number, url: string): BindingResolution {
  const found = map[tabId]
  if (!found) return { kind: 'fresh' }
  return found.originKey === originKey(url)
    ? { kind: 'existing', conversationId: found.conversationId }
    : { kind: 'fresh' }
}

/**
 * Point a tab at a conversation. Pure — returns a new map.
 *
 * Deliberately does NOT evict the conversation from other tabs that may also
 * point at it (reopening an old chat from the Library shouldn't blank out the
 * tab it came from). Uniqueness is instead resolved on the read side by
 * boundTabFor, and double-mounting is prevented by liveChatIds deduping.
 */
export function bindTab(
  map: TabChatMap,
  tabId: number,
  conversationId: string,
  url: string,
  now: number,
): TabChatMap {
  return { ...map, [tabId]: { conversationId, originKey: originKey(url), boundAt: now } }
}

/** Forget a tab (it closed). The conversation itself lives on in history. */
export function unbindTab(map: TabChatMap, tabId: number): TabChatMap {
  if (!(tabId in map)) return map
  const next = { ...map }
  delete next[tabId]
  return next
}

/**
 * The tab a conversation's tools should act on: the tab that most recently
 * claimed it. Two tabs can legitimately point at one chat (reopen an old chat on
 * a second tab and the first still remembers it), so "most recent wins" is what
 * makes the chat follow the user rather than stay pinned to where it was born.
 *
 * Callers must not re-pin a *running* chat — a turn is never yanked onto another
 * tab mid-flight. App enforces that by not re-binding while status is 'running'.
 */
export function boundTabFor(map: TabChatMap, conversationId: string): number | undefined {
  let best: { tabId: number; boundAt: number } | undefined
  for (const [key, binding] of Object.entries(map)) {
    if (binding.conversationId !== conversationId) continue
    if (!best || binding.boundAt > best.boundAt) best = { tabId: Number(key), boundAt: binding.boundAt }
  }
  return best?.tabId
}

/**
 * Which chats App must keep mounted: the visible one, plus every chat still
 * doing something. Deduped, visible first — a chat that is both visible and
 * running must mount exactly once, or two components would race on one
 * conversation's IndexedDB row.
 */
export function liveChatIds(visibleId: string, statuses: Record<string, ChatStatus>): string[] {
  const ids = [visibleId]
  for (const [id, status] of Object.entries(statuses)) {
    if (id !== visibleId && isLive(status)) ids.push(id)
  }
  return ids
}

/**
 * Whether a status change deserves a system toast. Only a chat that *was*
 * running and has now stopped — finished, parked, or waiting on approval — is
 * worth interrupting for, and only when the user isn't already looking at it.
 */
export function shouldToast(
  prev: ChatStatus,
  next: ChatStatus,
  view: { visible: boolean; panelFocused: boolean },
): boolean {
  if (prev !== 'running' || next === 'running') return false
  // States the user must act on are announced by needsAttention instead, which
  // also catches the case where they arise with no transition to observe.
  if (needsAttention(next)) return false
  return !(view.visible && view.panelFocused)
}

/**
 * Whether a chat that wants the user should be announced right now: it is
 * blocked, they cannot see it, and they have not already been told about this
 * particular episode of being blocked.
 */
export function shouldAnnounceAttention(
  status: ChatStatus,
  announced: ChatStatus | undefined,
  view: { visible: boolean; panelFocused: boolean },
): boolean {
  if (!needsAttention(status)) return false
  if (announced === status) return false
  return !(view.visible && view.panelFocused)
}

// ---------------------------------------------------------------------------
// chrome.storage.session mirroring
// ---------------------------------------------------------------------------

const MAP_KEY = 'tabChats'
const RUNNING_KEY = 'runningChats'

export async function loadTabChats(): Promise<TabChatMap> {
  try {
    const data = await chrome.storage.session.get(MAP_KEY)
    const value = data[MAP_KEY]
    return value && typeof value === 'object' ? (value as TabChatMap) : {}
  } catch {
    // Session storage is best-effort: losing the map costs the user a fresh
    // chat, never a stored conversation, so a failure must not break the panel.
    return {}
  }
}

export async function saveTabChats(map: TabChatMap): Promise<void> {
  try {
    await chrome.storage.session.set({ [MAP_KEY]: map })
  } catch {}
}

/**
 * The conversations currently mid-turn, shared across windows so a *second*
 * window's Library can refuse to open a chat this window is still running —
 * two panels mounting one conversation would race on its transcript row.
 */
export async function loadRunningChats(): Promise<string[]> {
  try {
    const data = await chrome.storage.session.get(RUNNING_KEY)
    const value = data[RUNNING_KEY]
    return Array.isArray(value) ? (value as string[]) : []
  } catch {
    return []
  }
}

export async function saveRunningChats(ids: string[]): Promise<void> {
  try {
    await chrome.storage.session.set({ [RUNNING_KEY]: ids })
  } catch {}
}
