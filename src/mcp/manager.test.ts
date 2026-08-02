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

function stubChromeStorage(): void {
  const store: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items)
        }),
      },
    },
  })
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
