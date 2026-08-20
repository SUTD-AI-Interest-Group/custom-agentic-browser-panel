import { afterEach, expect, test, vi } from 'vitest'
import {
  bindTab,
  boundTabFor,
  isLive,
  liveChatIds,
  loadRunningChats,
  loadTabChats,
  needsAttention,
  originKey,
  resolveBinding,
  saveRunningChats,
  saveTabChats,
  shouldAnnounceAttention,
  shouldToast,
  unbindTab,
  type TabChatMap,
} from './tabChats'

// Minimal chrome.storage.session stub — the get/set surface tabChats.ts calls,
// and nothing else. `fail` makes every call throw, to prove the module degrades
// to "no binding" rather than propagating a storage error into the panel.
function stubSession(opts: { fail?: boolean } = {}) {
  const store: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: vi.fn(async (key: string) => {
          if (opts.fail) throw new Error('session storage unavailable')
          return key in store ? { [key]: store[key] } : {}
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          if (opts.fail) throw new Error('session storage unavailable')
          Object.assign(store, items)
        }),
      },
    },
  })
  return store
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// --- originKey ------------------------------------------------------------

test('originKey keys on scheme and host', () => {
  expect(originKey('https://github.com/foo/bar?x=1#y')).toBe('https://github.com')
  expect(originKey('https://github.com/other')).toBe('https://github.com')
  expect(originKey('http://github.com/foo')).toBe('http://github.com')
})

test('originKey separates subdomains and ports', () => {
  expect(originKey('https://gist.github.com/x')).not.toBe(originKey('https://github.com/x'))
  expect(originKey('http://localhost:3000/a')).not.toBe(originKey('http://localhost:5173/a'))
})

test('originKey distinguishes chrome:// pages by host', () => {
  expect(originKey('chrome://extensions')).toBe('chrome://extensions')
  expect(originKey('chrome://settings')).toBe('chrome://settings')
})

// URL.origin returns the literal string "null" for these, which would collapse
// every local file onto a single shared chat.
test('originKey falls back to the whole URL for hostless schemes', () => {
  expect(originKey('file:///Users/me/a.html')).toBe('file:///Users/me/a.html')
  expect(originKey('file:///Users/me/b.html')).not.toBe(originKey('file:///Users/me/a.html'))
  expect(originKey('about:blank')).toBe('about:blank')
})

test('originKey tolerates unparseable and empty urls', () => {
  expect(originKey('')).toBe('')
  expect(originKey('   ')).toBe('')
  expect(originKey('not a url')).toBe('not a url')
  expect(originKey(undefined as unknown as string)).toBe('')
})

// --- resolveBinding -------------------------------------------------------

const MAP: TabChatMap = {
  7: { conversationId: 'conv-a', originKey: 'https://github.com', boundAt: 100 },
}

test('resolveBinding returns the existing chat on the same origin', () => {
  expect(resolveBinding(MAP, 7, 'https://github.com/other/page')).toEqual({
    kind: 'existing',
    conversationId: 'conv-a',
  })
})

test('resolveBinding mints a fresh chat after a cross-origin navigation', () => {
  expect(resolveBinding(MAP, 7, 'https://youtube.com/watch')).toEqual({ kind: 'fresh' })
})

test('resolveBinding mints a fresh chat for an unknown tab', () => {
  expect(resolveBinding(MAP, 99, 'https://github.com/foo')).toEqual({ kind: 'fresh' })
})

// Split view: the pane beside this one already has a chat, so this pane joins it
// rather than minting its own. Without this, focusing the other half of a split
// looked exactly like switching to an unknown tab.
test('resolveBinding adopts the split partner chat for an unbound pane', () => {
  expect(
    resolveBinding(MAP, 99, 'https://news.example.com/a', { tabId: 7, url: 'https://github.com/x' }),
  ).toEqual({ kind: 'adopted', conversationId: 'conv-a' })
})

// The adopting pane's own URL is irrelevant — a split exists precisely so two
// unrelated pages can be looked at together, so the shared chat must survive
// them being on different origins.
test('resolveBinding adopts across origins', () => {
  expect(
    resolveBinding(MAP, 99, 'file:///tmp/notes.txt', { tabId: 7, url: 'https://github.com/x' }),
  ).toEqual({ kind: 'adopted', conversationId: 'conv-a' })
})

// Own binding wins: two tabs that each had a chat before Chrome paired them into
// a split keep them. Adoption is for a pane with nothing to lose.
test('resolveBinding prefers this pane own live binding over the partner', () => {
  const map: TabChatMap = {
    ...MAP,
    8: { conversationId: 'conv-b', originKey: 'https://news.example.com', boundAt: 200 },
  }
  expect(
    resolveBinding(map, 8, 'https://news.example.com/a', { tabId: 7, url: 'https://github.com/x' }),
  ).toEqual({ kind: 'existing', conversationId: 'conv-b' })
})

// A stale own binding is not a binding, so the partner still gets to donate.
test('resolveBinding adopts when this pane own binding went stale', () => {
  const map: TabChatMap = {
    ...MAP,
    8: { conversationId: 'conv-b', originKey: 'https://news.example.com', boundAt: 200 },
  }
  expect(
    resolveBinding(map, 8, 'https://elsewhere.example.org/a', { tabId: 7, url: 'https://github.com/x' }),
  ).toEqual({ kind: 'adopted', conversationId: 'conv-a' })
})

test('resolveBinding does not adopt a partner whose own binding went stale', () => {
  expect(
    resolveBinding(MAP, 99, 'https://news.example.com/a', { tabId: 7, url: 'https://youtube.com/watch' }),
  ).toEqual({ kind: 'fresh' })
})

test('resolveBinding does not adopt from a partner that has no binding', () => {
  expect(
    resolveBinding(MAP, 99, 'https://news.example.com/a', { tabId: 42, url: 'https://github.com/x' }),
  ).toEqual({ kind: 'fresh' })
})

// Chrome < 140 reports no split, so App passes no partner and nothing changes.
test('resolveBinding without a partner behaves exactly as before', () => {
  expect(resolveBinding(MAP, 99, 'https://github.com/foo', undefined)).toEqual({ kind: 'fresh' })
})

// --- bindTab / unbindTab --------------------------------------------------

test('bindTab is pure and records the origin it bound against', () => {
  const next = bindTab(MAP, 8, 'conv-b', 'https://news.ycombinator.com/item?id=1', 200)
  expect(next[8]).toEqual({
    conversationId: 'conv-b',
    originKey: 'https://news.ycombinator.com',
    boundAt: 200,
  })
  expect(MAP[8]).toBeUndefined() // original untouched
})

test('bindTab leaves other tabs pointing at the same chat alone', () => {
  // Reopening conv-a on tab 8 must not blank out tab 7, which still remembers it.
  const next = bindTab(MAP, 8, 'conv-a', 'https://youtube.com/watch', 200)
  expect(next[7].conversationId).toBe('conv-a')
  expect(next[8].conversationId).toBe('conv-a')
})

test('unbindTab drops a closed tab and no-ops on an unknown one', () => {
  const two = bindTab(MAP, 8, 'conv-b', 'https://x.com', 200)
  expect(Object.keys(unbindTab(two, 8))).toEqual(['7'])
  expect(unbindTab(MAP, 42)).toBe(MAP) // unknown tab: same object, no copy
})

// --- boundTabFor ----------------------------------------------------------

test('boundTabFor picks the tab that most recently claimed the chat', () => {
  const map = bindTab(MAP, 8, 'conv-a', 'https://youtube.com/watch', 300)
  expect(boundTabFor(map, 'conv-a')).toBe(8)
})

test('boundTabFor ignores other conversations and returns undefined when unbound', () => {
  const map = bindTab(MAP, 8, 'conv-b', 'https://youtube.com', 300)
  expect(boundTabFor(map, 'conv-a')).toBe(7)
  expect(boundTabFor(map, 'conv-missing')).toBeUndefined()
})

// --- liveChatIds ----------------------------------------------------------

test('liveChatIds keeps the visible chat plus everything still working', () => {
  expect(
    liveChatIds('vis', { vis: 'idle', a: 'running', b: 'idle', c: 'parked', d: 'needs-you' }),
  ).toEqual(['vis', 'a', 'c', 'd'])
})

test('liveChatIds mounts a visible-and-running chat exactly once', () => {
  expect(liveChatIds('vis', { vis: 'running' })).toEqual(['vis'])
})

test('liveChatIds always includes the visible chat even with no status yet', () => {
  expect(liveChatIds('vis', {})).toEqual(['vis'])
})

test('isLive treats only idle as done', () => {
  expect(isLive('idle')).toBe(false)
  expect(isLive('running')).toBe(true)
  expect(isLive('parked')).toBe(true)
  expect(isLive('needs-you')).toBe(true)
})

// --- shouldToast ----------------------------------------------------------

const AWAY = { visible: false, panelFocused: true }

test('shouldToast fires when a background chat finishes', () => {
  expect(shouldToast('running', 'idle', AWAY)).toBe(true)
})

// Blocked states are announced by shouldAnnounceAttention instead, which also
// catches them arising with no transition at all. Announcing from both would
// double-notify the one case they overlap on.
test('shouldToast leaves the blocked states to the attention path', () => {
  expect(shouldToast('running', 'parked', AWAY)).toBe(false)
  expect(shouldToast('running', 'needs-you', AWAY)).toBe(false)
})

test('shouldToast stays quiet when the user is already watching that chat', () => {
  expect(shouldToast('running', 'idle', { visible: true, panelFocused: true })).toBe(false)
})

test('shouldToast still fires for a visible chat when the panel is not focused', () => {
  expect(shouldToast('running', 'idle', { visible: true, panelFocused: false })).toBe(true)
})

test('shouldToast ignores transitions that are not a turn ending', () => {
  expect(shouldToast('idle', 'running', AWAY)).toBe(false)
  expect(shouldToast('idle', 'idle', AWAY)).toBe(false)
  expect(shouldToast('parked', 'running', AWAY)).toBe(false)
  expect(shouldToast('running', 'running', AWAY)).toBe(false)
})

// --- shouldAnnounceAttention ----------------------------------------------

test('needsAttention marks only the states blocked on the user', () => {
  expect(needsAttention('needs-you')).toBe(true)
  expect(needsAttention('parked')).toBe(true)
  expect(needsAttention('running')).toBe(false)
  expect(needsAttention('idle')).toBe(false)
})

test('shouldAnnounceAttention announces a blocked, out-of-sight chat', () => {
  expect(shouldAnnounceAttention('needs-you', undefined, AWAY)).toBe(true)
  expect(shouldAnnounceAttention('parked', undefined, AWAY)).toBe(true)
})

// The regression this exists for: an approval card that appeared while the user
// was watching the chat is silent (right), and switching away changes no status
// — so a transition-based check never fires and the chat waits in silence. The
// state-based check announces it the moment it stops being visible.
test('shouldAnnounceAttention fires once the user switches away from a blocked chat', () => {
  const watching = { visible: true, panelFocused: true }
  expect(shouldAnnounceAttention('needs-you', undefined, watching)).toBe(false)
  // Same status, same announced record — only visibility changed.
  expect(shouldAnnounceAttention('needs-you', undefined, AWAY)).toBe(true)
})

test('shouldAnnounceAttention fires when the panel loses focus with the card up', () => {
  expect(shouldAnnounceAttention('needs-you', undefined, { visible: true, panelFocused: false })).toBe(true)
})

test('shouldAnnounceAttention does not repeat within one blocked episode', () => {
  expect(shouldAnnounceAttention('needs-you', 'needs-you', AWAY)).toBe(false)
})

// A chat that was parked and is now waiting on approval is a genuinely new thing
// to tell the user about, so a different state re-announces.
test('shouldAnnounceAttention re-announces when the blocked state changes', () => {
  expect(shouldAnnounceAttention('needs-you', 'parked', AWAY)).toBe(true)
})

test('shouldAnnounceAttention ignores chats that are working or done', () => {
  expect(shouldAnnounceAttention('running', undefined, AWAY)).toBe(false)
  expect(shouldAnnounceAttention('idle', undefined, AWAY)).toBe(false)
})

// --- storage --------------------------------------------------------------

test('tab chat map round-trips through session storage', async () => {
  stubSession()
  expect(await loadTabChats()).toEqual({})
  const map = bindTab({}, 3, 'conv-x', 'https://example.com/a', 1)
  await saveTabChats(map)
  expect(await loadTabChats()).toEqual(map)
})

test('running chat ids round-trip through session storage', async () => {
  stubSession()
  expect(await loadRunningChats()).toEqual([])
  await saveRunningChats(['conv-x', 'conv-y'])
  expect(await loadRunningChats()).toEqual(['conv-x', 'conv-y'])
})

// Losing the map costs the user a fresh chat, never a stored conversation — so a
// storage failure must degrade quietly rather than take the panel down with it.
test('storage failures degrade to empty rather than throwing', async () => {
  stubSession({ fail: true })
  expect(await loadTabChats()).toEqual({})
  expect(await loadRunningChats()).toEqual([])
  await expect(saveTabChats({})).resolves.toBeUndefined()
  await expect(saveRunningChats(['a'])).resolves.toBeUndefined()
})
