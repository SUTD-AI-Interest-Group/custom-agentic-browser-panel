import { test, expect, vi, afterEach } from 'vitest'
import { closeTabs, reopenClosedTabs } from './tabs'

afterEach(() => {
  vi.unstubAllGlobals()
})

test('closeTabs does not let one stale id abort removal of the still-valid ones', async () => {
  // Tab 3 closed for real in the human-reaction-time gap between the approval
  // card rendering and the user clicking Close — chrome.tabs.get already
  // vets this per-id (it's skipped from the stash), but the current code
  // still hands the RAW, unfiltered id list to chrome.tabs.remove(), which
  // rejects the whole batch over that one stale id.
  const removeCalls: number[][] = []
  const stored: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async (id: number) => {
        if (id === 3) throw new Error('No tab with id: 3.')
        return { url: `https://x.com/${id}`, title: `Tab ${id}`, windowId: 1, index: id, pinned: false }
      }),
      remove: vi.fn(async (ids: number[]) => {
        removeCalls.push(ids)
        if (ids.includes(3)) throw new Error('Tabs not found: [3].')
      }),
    },
    storage: {
      local: {
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(stored, items)
        }),
      },
    },
  })

  const result = await closeTabs([1, 2, 3])

  expect(result.error).toBeUndefined()
  expect(result.closed.map((t) => t.url)).toEqual(['https://x.com/1', 'https://x.com/2'])
  // remove() must only ever have been asked about ids chrome.tabs.get actually
  // confirmed exist — never the raw, unfiltered [1,2,3].
  expect(removeCalls).toEqual([[1, 2]])
})

test('closeTabs reports nothing closed (not an error) when every id was already stale', async () => {
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async () => {
        throw new Error('No tab with id.')
      }),
      remove: vi.fn(async () => {
        throw new Error('should never be called with an empty id list')
      }),
    },
    storage: {
      local: { set: vi.fn(async () => {}) },
    },
  })

  const result = await closeTabs([9, 10])
  expect(result).toEqual({ closed: [], recoverable: 0 })
})

test('reopenClosedTabs restores ascending (window, index) order even when the stash is out of order', async () => {
  // Two same-window tabs stashed in descending-index order (the model can name
  // tabs in any order) — recreating index 5 before index 2 would push the
  // earlier tab rightward and scramble their relative order in the reopened
  // window.
  const created: Array<{ index: number }> = []
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async () => ({
          'closedTabs:last': {
            at: Date.now(),
            tabs: [
              { url: 'https://b.com', title: 'B', windowId: 1, index: 5, pinned: false },
              { url: 'https://a.com', title: 'A', windowId: 1, index: 2, pinned: false },
            ],
          },
        })),
        remove: vi.fn(async () => {}),
      },
    },
    windows: { get: vi.fn(async () => ({ id: 1 })) },
    tabs: {
      create: vi.fn(async (opts: { index: number }) => {
        created.push(opts)
        return { id: created.length }
      }),
    },
  })

  const result = await reopenClosedTabs()
  expect(result.reopened).toBe(2)
  expect(created.map((c) => c.index)).toEqual([2, 5])
})
