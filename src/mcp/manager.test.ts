// McpManager's connection lifecycle is Chrome/SSE-coupled (real transports,
// real chrome.storage.local), so this suite substitutes the one seam the
// module already depends on for its network identity — the SDK's `Client`
// class — with a fake whose `listTools()` we fully control via a manually
// resolved/rejected "gate" promise. That makes the handshake-then-catalog-
// fetch sequence deterministic without guessing at microtask ordering: the
// fake handshake (`connect()`) always succeeds instantly, and the chain is
// guaranteed to be parked on the gate the moment it reaches the catalog
// fetch, however many ticks that took to get there.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../data/settings'
import { McpManager } from './manager'

const state = vi.hoisted(() => ({
  listToolsImpl: async (): Promise<{ tools: { name: string; description?: string; inputSchema: unknown }[] }> => ({
    tools: [],
  }),
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class FakeClient {
    onclose?: () => void
    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    getServerCapabilities() {
      return { tools: {} }
    }
    listTools() {
      return state.listToolsImpl()
    }
    async listResources() {
      return { resources: [] }
    }
    async listPrompts() {
      return { prompts: [] }
    }
    setNotificationHandler() {}
    async callTool() {
      return {}
    }
    async readResource() {
      return {}
    }
    async getPrompt() {
      return {}
    }
  }
  return { Client: FakeClient }
})

/**
 * `seed` lets a test pre-populate storage (e.g. a `mcpAuth:<name>` entry, or
 * the `mcpCatalog` cache) before the manager ever touches it. Real
 * `remove()` is needed for the token-scoping tests below: they assert on
 * actual storage state after a purge rather than mocking `clearAuth` itself,
 * so the purge path exercises the real (trivial) implementation.
 */
function stubChromeStorage(seed: Record<string, unknown> = {}): Record<string, unknown> {
  const store: Record<string, unknown> = { ...seed }
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

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const settings = { mcp: { servers: { srv: { url: 'https://example.com/mcp' } } } } as unknown as Settings

beforeEach(() => {
  state.listToolsImpl = async () => ({ tools: [] })
})

describe('McpManager — catalog-fetch failure after a successful handshake (F3)', () => {
  it('does not permanently strand the slot: a later ensureConnected/callTool actually retries', async () => {
    stubChromeStorage()
    const gate = deferred<{ tools: { name: string; description?: string; inputSchema: unknown }[] }>()
    state.listToolsImpl = () => gate.promise

    const manager = new McpManager()
    await manager.refresh(settings)

    // connect() is guaranteed to be parked on gate.promise by now (the fake
    // handshake never fails and listTools() never resolves on its own) —
    // reject it to simulate a transient catalog-fetch hiccup right after a
    // successful connect, then wait for the manager to observe it.
    gate.reject(new Error('listTools boom'))
    await vi.waitFor(() => {
      const s = manager.runtime().find((x) => x.name === 'srv')
      if (s?.status !== 'error') throw new Error('not settled yet')
    })

    const afterFailure = manager.runtime().find((s) => s.name === 'srv')
    expect(afterFailure?.tools).toEqual([])

    // The bug: connect() installs slot.client/transport BEFORE the catalog
    // fetch, and the catch path never cleared them on a catalog-only failure —
    // leaving a live client with status:'error'. ensureConnected's own
    // `if (slot.client) return` guard then short-circuits every future call
    // (exactly what a real tool call does before callTool) with no retry at
    // all, so the server's tools vanish forever. Fixed, ensureConnected must
    // actually attempt connect() again here.
    state.listToolsImpl = async () => ({ tools: [{ name: 'do_thing', description: '', inputSchema: {} }] })
    await manager.ensureConnected('srv')

    const afterRetry = manager.runtime().find((s) => s.name === 'srv')
    expect(afterRetry?.status).toBe('connected')
    expect(afterRetry?.tools).toHaveLength(1)

    manager.disconnectAll()
  })

  it('still reports the failure to the original caller of ensureConnected', async () => {
    stubChromeStorage()
    const gate = deferred<{ tools: { name: string; description?: string; inputSchema: unknown }[] }>()
    state.listToolsImpl = () => gate.promise

    const manager = new McpManager()
    await manager.refresh(settings)
    const pending = manager.ensureConnected('srv')
    gate.reject(new Error('listTools boom'))
    await expect(pending).rejects.toThrow(/listTools boom/)

    manager.disconnectAll()
  })
})

// Regression coverage for the OAuth token-replay fix: refresh() must purge a
// server's stored auth (src/mcp/auth.ts's `mcpAuth:<name>` record) exactly
// when its identity actually changes — URL edit or outright removal — and
// never on an ordinary reconnect where nothing changed. These assert on real
// `chrome.storage.local` state (no mocking of ./auth) so the purge path
// exercises the real clearAuth() implementation, not a stand-in for it.
describe('McpManager — MCP OAuth token scoping', () => {
  const seedToken = { 'mcpAuth:srv': { tokens: { access_token: 'at-1', token_type: 'Bearer' }, boundUrl: 'https://a.example.com/mcp' } }

  it('purges stored auth when an entry\'s URL changes, before reconnecting', async () => {
    const store = stubChromeStorage(seedToken)
    const manager = new McpManager()

    await manager.refresh({ mcp: { servers: { srv: { url: 'https://a.example.com/mcp' } } } } as unknown as Settings)
    // First-ever population of this slot: nothing to diff against yet, so no
    // purge — the pre-seeded token must survive untouched.
    expect(store['mcpAuth:srv']).toBeDefined()

    await manager.refresh({ mcp: { servers: { srv: { url: 'https://b.example.com/mcp' } } } } as unknown as Settings)
    expect(store['mcpAuth:srv']).toBeUndefined()

    manager.disconnectAll()
  })

  it('keeps stored auth across a refresh where the entry is unchanged (no false purge)', async () => {
    const store = stubChromeStorage(seedToken)
    const manager = new McpManager()
    const cfg = { mcp: { servers: { srv: { url: 'https://a.example.com/mcp' } } } } as unknown as Settings

    await manager.refresh(cfg)
    // A second save elsewhere in Settings re-triggers refresh() with the same
    // MCP config — App.tsx calls refresh() on every settings change.
    await manager.refresh(cfg)
    expect(store['mcpAuth:srv']).toBeDefined()

    manager.disconnectAll()
  })

  it('does not false-purge a server\'s first-ever connection when its slot was seeded from the catalog cache', async () => {
    // loadCatalogCache() seeds a placeholder slot (entry: {}) for a name it
    // has cached tools for but has never actually connected to this session
    // (see its own comment: "refresh() will fix status/entry immediately
    // after"). That placeholder's `.entry.url` is undefined, which must NOT
    // be treated as a prior "real" URL that then looks changed once refresh()
    // fills in the actual entry.
    const store = stubChromeStorage({
      ...seedToken,
      mcpCatalog: { srv: { tools: [{ name: 'x', description: '', inputSchema: {} }], resources: [], prompts: [] } },
    })
    const manager = new McpManager()

    await manager.refresh({ mcp: { servers: { srv: { url: 'https://a.example.com/mcp' } } } } as unknown as Settings)
    expect(store['mcpAuth:srv']).toBeDefined()

    manager.disconnectAll()
  })

  it('purges stored auth when a server is removed — a later re-add under the same name does not inherit it', async () => {
    const store = stubChromeStorage(seedToken)
    const manager = new McpManager()
    const withServer = { mcp: { servers: { srv: { url: 'https://a.example.com/mcp' } } } } as unknown as Settings

    await manager.refresh(withServer)
    expect(store['mcpAuth:srv']).toBeDefined()

    await manager.refresh({ mcp: { servers: {} } } as unknown as Settings)
    expect(store['mcpAuth:srv']).toBeUndefined()

    // Re-added under the identical name AND URL — even so, nothing is left
    // to inherit, because removal purges by name outright.
    await manager.refresh(withServer)
    expect(store['mcpAuth:srv']).toBeUndefined()

    manager.disconnectAll()
  })
})

// persistCatalogCache() re-serializes and writes EVERY connected server's
// catalog on every single listCatalog() completion — a refresh() that
// connects several servers at once (or a burst of listChanged notifications)
// used to pay one full O(all servers) write per server instead of one for the
// whole batch. The manager now debounces these writes; assert the write COUNT
// (structural), never anything wall-clock — fake timers advanced deterministically.
describe('McpManager — catalog cache write coalescing (F4)', () => {
  it('coalesces two servers connecting close together into a single persisted write', async () => {
    vi.useFakeTimers()
    const store: Record<string, unknown> = {}
    const setSpy = vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(store, items)
    })
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
          set: setSpy,
          remove: vi.fn(async (key: string) => {
            delete store[key]
          }),
        },
      },
    })

    try {
      state.listToolsImpl = async () => ({ tools: [{ name: 'do_thing', description: '', inputSchema: {} }] })
      const twoServers = {
        mcp: {
          servers: {
            srv1: { url: 'https://a.example.com/mcp' },
            srv2: { url: 'https://b.example.com/mcp' },
          },
        },
      } as unknown as Settings

      const manager = new McpManager()
      await manager.refresh(twoServers)
      // Both servers' connect()+listCatalog() chains settle within a handful
      // of microtask ticks (the fake Client never touches a real timer) — flush
      // those WITHOUT yet advancing past the debounce window, so both catalog
      // completions land inside the same coalescing window this test exists to
      // prove.
      await vi.advanceTimersByTimeAsync(0)

      // Now let the one scheduled write actually fire.
      await vi.advanceTimersByTimeAsync(1000)

      const catalogWrites = setSpy.mock.calls.filter(([items]) => 'mcpCatalog' in items)
      expect(catalogWrites).toHaveLength(1) // ONE write for both servers, not two
      const written = catalogWrites[0][0] as { mcpCatalog: Record<string, { tools: unknown[] }> }
      expect(written.mcpCatalog.srv1.tools).toHaveLength(1)
      expect(written.mcpCatalog.srv2.tools).toHaveLength(1)

      manager.disconnectAll()
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})
