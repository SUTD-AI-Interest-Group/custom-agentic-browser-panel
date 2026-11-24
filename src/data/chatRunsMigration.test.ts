import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRun } from './chatRuns'

// Builds before the spec/live split kept each whole run in the `runs` store. Those records must
// come through an extension update intact, split in the same upgrade that adds the live store.
const NAME = 'lychee-chat-runs'

function legacyRun(conversationId: string, state: ChatRun['state']): ChatRun {
  return {
    id: `run-${conversationId}`, conversationId, owner: 'old-panel', ownerUntil: 0, chainId: 'chain', windowId: 3, tabId: 9,
    assistantId: 'answer', modelId: 'fixture', providerId: 'p', system: 'Answer.', history: [{ role: 'user', content: 'Question' }],
    messages: [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'Question' }] }], baseParts: [],
    tools: [{ name: 'ReadPage', inputSchema: {} }], images: [], activeNames: ['ReadPage'], parts: [{ type: 'text', text: 'Partial' }],
    partsVersion: 4, state, updatedAt: 1, toolRequests: [], steps: [], approvals: [], allowedTools: ['ReadPage'],
  }
}

function seed(version: number, runs: ChatRun[], index = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, version)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('runs', { keyPath: 'conversationId' })
      if (index) store.createIndex('byState', 'state')
      for (const run of runs) store.put(run)
    }
    request.onsuccess = () => { request.result.close(); resolve() }
    request.onerror = () => reject(request.error)
  })
}
const drop = () => new Promise<void>((resolve, reject) => {
  const request = indexedDB.deleteDatabase(NAME)
  request.onsuccess = () => resolve(); request.onerror = () => reject(request.error)
})
function inspect(): Promise<{ version: number; stores: string[]; indexes: string[]; runs: Record<string, unknown>[]; live: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(['runs', 'live'])
      const indexes = [...tx.objectStore('runs').indexNames]
      const runs = tx.objectStore('runs').getAll(), live = tx.objectStore('live').getAll()
      tx.oncomplete = () => {
        db.close()
        resolve({ version: db.version, stores: [...db.objectStoreNames], indexes, runs: runs.result, live: live.result })
      }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
  })
}

beforeEach(async () => {
  vi.resetModules()
  await drop()
})

describe('upgrading a pre-split chat-run database', () => {
  for (const [label, version, index] of [['v1', 1, false], ['v2 with an index', 2, true]] as const) {
    it(`splits every stored run in place (${label})`, async () => {
      const active = legacyRun('chat-a', 'running'), finished = legacyRun('chat-b', 'done')
      await seed(version, [active, finished], index)
      const runs = await import('./chatRuns')
      // Every field survives, on the right side.
      expect(await runs.getChatRun('chat-a')).toEqual(active)
      expect(await runs.getChatRun('chat-b')).toEqual(finished)
      expect((await runs.getChatRunLive('chat-a'))?.state).toBe('running')
      const after = await inspect()
      expect(after.version).toBe(version + 1)
      expect(after.stores.sort()).toEqual(['live', 'runs'])
      expect(after.indexes).toEqual(index ? ['byState'] : [])
      for (const spec of after.runs) {
        expect(spec).toHaveProperty('history')
        expect(spec).not.toHaveProperty('parts')
        expect(spec).not.toHaveProperty('state')
      }
      for (const live of after.live) {
        expect(live).toHaveProperty('parts')
        expect(live).not.toHaveProperty('history')
        expect(live).not.toHaveProperty('tools')
      }
      // The upgraded store still enforces one run in flight.
      await expect(runs.createChatRun({ ...legacyRun('chat-a', 'queued'), id: 'new' })).rejects.toThrow(/already generating/)
    })
  }

  it('starts a fresh install with both stores and nothing to migrate', async () => {
    const runs = await import('./chatRuns')
    expect(await runs.listChatRuns()).toEqual([])
    const after = await inspect()
    expect(after.version).toBe(1)
    expect(after.stores.sort()).toEqual(['live', 'runs'])
  })
})
