import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendToEpisode,
  clearDreamLock,
  clearDreamState,
  clearMemory,
  deleteMemory,
  getDreamLock,
  getDreamState,
  listMemories,
  listUnconsolidatedEpisodes,
  markEpisodesConsolidated,
  memoryUsage,
  pruneConsolidatedEpisodes,
  saveMemory,
  setDreamLock,
  setDreamState,
  updateMemory,
  type EpisodeMessage,
} from './memory'

// memory.ts had ZERO test coverage before this file, despite its own header
// stating the IndexedDB store "is shared between the side panel and the
// background service worker" — exactly the split that let two concurrent
// dream cycles interleave their reads/writes (see dream.test.ts for the fix
// and its regression coverage). This file covers the storage primitives
// themselves: basic CRUD, the dream-state/dream-lock get/set/clear helpers
// dream.ts builds its reentrancy guard on top of, and documents (rather than
// papers over) the one non-atomic edge these primitives still have.

function stubChromeStorage(): Record<string, unknown> {
  const store: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items)
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key]
        }),
      },
    },
  })
  return store
}

function msg(text: string): EpisodeMessage {
  return { role: 'user', text, at: Date.now() }
}

beforeEach(async () => {
  stubChromeStorage()
  // memories/episodes live in IndexedDB, a single process-wide database under
  // fake-indexeddb — start each test clean rather than accumulating rows
  // across the whole file.
  await clearMemory()
})

describe('memories CRUD', () => {
  it('saveMemory assigns an id and timestamps; listMemories sorts newest-first', async () => {
    // Fake the clock so the two saves land in different milliseconds — two
    // real back-to-back calls can otherwise tie on updatedAt, and IndexedDB's
    // getAll() order for a string keyPath is by key, not insertion order, so
    // a tie would make this assertion flaky rather than wrong.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(0)
      const a = await saveMemory({ kind: 'fact', content: 'first', source: 'user' })
      vi.setSystemTime(1)
      const b = await saveMemory({ kind: 'fact', content: 'second', source: 'user' })
      expect(a.id).not.toBe(b.id)
      const all = await listMemories()
      expect(all.map((m) => m.id)).toEqual([b.id, a.id])
    } finally {
      vi.useRealTimers()
    }
  })

  it('trims content and lowercases/trims tags', async () => {
    const m = await saveMemory({ kind: 'preference', content: '  spaced  ', tags: [' Foo ', 'BAR'], source: 'user' })
    expect(m.content).toBe('spaced')
    expect(m.tags).toEqual(['foo', 'bar'])
  })

  it('updateMemory patches content/tags and bumps updatedAt; returns null for a missing id', async () => {
    const m = await saveMemory({ kind: 'fact', content: 'old', source: 'agent' })
    const updated = await updateMemory(m.id, { content: 'new' })
    expect(updated?.content).toBe('new')
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(m.updatedAt)
    expect(await updateMemory('missing-id', { content: 'x' })).toBeNull()
  })

  it('deleteMemory removes it from listMemories', async () => {
    const m = await saveMemory({ kind: 'fact', content: 'gone soon', source: 'user' })
    await deleteMemory(m.id)
    expect(await listMemories()).toEqual([])
  })

  it('two concurrent updateMemory calls for the SAME id do not corrupt the record (clean last-write-wins, never merged/duplicated) — exactly the race dream.ts\'s reentrancy lock exists to keep two dream cycles from ever doing to each other', async () => {
    const m = await saveMemory({ kind: 'fact', content: 'v0', source: 'user' })
    const [r1, r2] = await Promise.all([
      updateMemory(m.id, { content: 'from-A' }),
      updateMemory(m.id, { content: 'from-B' }),
    ])
    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    const all = await listMemories()
    expect(all).toHaveLength(1) // never duplicated
    expect(['from-A', 'from-B']).toContain(all[0].content) // one wins cleanly, not garbled
  })
})

describe('episodes', () => {
  it('appendToEpisode creates then appends to the same episode id', async () => {
    await appendToEpisode('ep1', [msg('hello')])
    await appendToEpisode('ep1', [msg('world')])
    const pending = await listUnconsolidatedEpisodes()
    expect(pending).toHaveLength(1)
    expect(pending[0].messages.map((m) => m.text)).toEqual(['hello', 'world'])
  })

  it('listUnconsolidatedEpisodes excludes consolidated and empty episodes', async () => {
    await appendToEpisode('ep-empty', [])
    await appendToEpisode('ep-real', [msg('x')])
    await appendToEpisode('ep-done', [msg('y')])
    await markEpisodesConsolidated(['ep-done'])
    const pending = await listUnconsolidatedEpisodes()
    expect(pending.map((e) => e.id)).toEqual(['ep-real'])
  })

  it('markEpisodesConsolidated is a no-op for an id that does not exist', async () => {
    await expect(markEpisodesConsolidated(['nope'])).resolves.toBeUndefined()
  })

  it('pruneConsolidatedEpisodes deletes only consolidated episodes older than the cutoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(0)
      await appendToEpisode('ep-old', [msg('x')]) // updatedAt = 0

      vi.setSystemTime(20 * 86_400_000) // 20 days later
      await appendToEpisode('ep-recent', [msg('y')]) // updatedAt = 20 days
      await markEpisodesConsolidated(['ep-old', 'ep-recent'])

      // "now" is day 20; default cutoff is 14 days back = day 6. ep-old (day
      // 0) is older than the cutoff; ep-recent (day 20) is not.
      await pruneConsolidatedEpisodes()

      // ep-old was actually deleted: re-appending starts a brand new,
      // unconsolidated record (visible again).
      await appendToEpisode('ep-old', [msg('reborn')])
      const pending = await listUnconsolidatedEpisodes()
      expect(pending.map((e) => e.id)).toEqual(['ep-old'])
      expect(pending[0].messages.map((m) => m.text)).toEqual(['reborn'])

      // ep-recent survived (still consolidated, untouched): re-appending
      // mutates the existing record in place, so it stays invisible to
      // listUnconsolidatedEpisodes (consolidated is preserved, not reset).
      await appendToEpisode('ep-recent', [msg('more')])
      expect((await listUnconsolidatedEpisodes()).map((e) => e.id)).not.toContain('ep-recent')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('clearMemory', () => {
  it('wipes memories, episodes, and dream state in one call', async () => {
    await saveMemory({ kind: 'fact', content: 'x', source: 'user' })
    await appendToEpisode('ep1', [msg('y')])
    await setDreamState({ lastDreamAt: 123, lastSummary: 'hi', consecutiveParseFailures: 2 })
    await clearMemory()
    expect(await listMemories()).toEqual([])
    expect(await listUnconsolidatedEpisodes()).toEqual([])
    expect(await getDreamState()).toEqual({ lastDreamAt: null, lastSummary: null, consecutiveParseFailures: 0 })
  })
})

describe('dream state', () => {
  it('getDreamState fills in defaults for a fresh install', async () => {
    expect(await getDreamState()).toEqual({ lastDreamAt: null, lastSummary: null, consecutiveParseFailures: 0 })
  })

  it('getDreamState defaults consecutiveParseFailures for state saved before that field existed', async () => {
    await chrome.storage.local.set({ dreamState: { lastDreamAt: 5, lastSummary: null } })
    expect(await getDreamState()).toEqual({ lastDreamAt: 5, lastSummary: null, consecutiveParseFailures: 0 })
  })

  it('setDreamState/clearDreamState round-trip', async () => {
    await setDreamState({ lastDreamAt: 42, lastSummary: 'ok', consecutiveParseFailures: 1 })
    expect(await getDreamState()).toEqual({ lastDreamAt: 42, lastSummary: 'ok', consecutiveParseFailures: 1 })
    await clearDreamState()
    expect(await getDreamState()).toEqual({ lastDreamAt: null, lastSummary: null, consecutiveParseFailures: 0 })
  })
})

describe('dream lock primitives', () => {
  it('getDreamLock is null until set, round-trips, and clears', async () => {
    expect(await getDreamLock()).toBeNull()
    await setDreamLock({ token: 't1', acquiredAt: 100 })
    expect(await getDreamLock()).toEqual({ token: 't1', acquiredAt: 100 })
    await clearDreamLock()
    expect(await getDreamLock()).toBeNull()
  })

  it('a later setDreamLock overwrites (last write wins) — the exact same-tick race dream.ts guards against with an acquire-then-re-read', async () => {
    await setDreamLock({ token: 'a', acquiredAt: 1 })
    await setDreamLock({ token: 'b', acquiredAt: 2 })
    expect(await getDreamLock()).toEqual({ token: 'b', acquiredAt: 2 })
  })
})

describe('memoryUsage', () => {
  it('counts memories and reports an episode count in the detail string', async () => {
    await saveMemory({ kind: 'fact', content: 'x', source: 'user' })
    await appendToEpisode('ep1', [msg('y')])
    const usage = await memoryUsage()
    expect(usage.count).toBe(1)
    expect(usage.detail).toContain('1 memories')
    expect(usage.detail).toContain('1 episode')
    expect(usage.bytes).toBeGreaterThan(0)
  })
})
