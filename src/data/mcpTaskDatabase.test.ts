// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules(); vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(() => vi.unstubAllGlobals())
const legacy = { id: 'legacy', conversationId: 'chat', task: { taskId: 'one', status: 'completed' }, ready: true, result: { content: [{ type: 'text', text: 'saved' }] } }
const modern = { id: 'modern', conversationId: 'chat', taskId: 'two', status: 'working', ttlMs: null, nextPollAt: 0 }
async function seed(version: number, records: unknown[]) {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('lychee-mcp-tasks', version)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('tasks', { keyPath: 'id' })
      if (version === 2) request.result.createObjectStore('meta')
      for (const record of records) store.put(record)
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => { request.result.close(); resolve() }
  })
}
it.each([1, 2])('migrates v%s records without losing either protocol or a saved result', async version => {
  await seed(version, [legacy, modern])
  const sdk = await import('./mcpTasks'), current = await import('../mcp/tasks')
  expect(await sdk.listMcpTasks()).toEqual([legacy])
  expect(await current.listSavedTasks()).toEqual([modern])
  expect((await current.mcpTasksUsage()).count).toBe(2)
  expect((await sdk.claimMcpCompletion('legacy', 'panel'))?.result).toEqual(legacy.result)
})
it('clears both stores and rejects delayed creations against the old epoch', async () => {
  await seed(2, [legacy, modern])
  const sdk = await import('./mcpTasks'), current = await import('../mcp/tasks')
  const epoch = await current.taskStorageEpoch()
  await current.clearMcpTasks()
  await expect(sdk.updateMcpTask('late', () => ({ ...legacy, id: 'late' }) as any, epoch)).rejects.toThrow('storage changed')
  await expect(current.saveTask({ ...modern, id: 'late' } as any, epoch)).rejects.toThrow()
  expect(await sdk.listMcpTasks()).toEqual([])
  expect(await current.listSavedTasks()).toEqual([])
})
it('deleting a chat removes both task formats and preserves other conversations', async () => {
  await seed(2, [legacy, modern, { ...legacy, id: 'other-legacy', conversationId: 'other' }, { ...modern, id: 'other-modern', conversationId: 'other' }])
  const sdk = await import('./mcpTasks'), current = await import('../mcp/tasks')
  await sdk.deleteMcpTasks('chat')
  expect((await sdk.listMcpTasks()).map(x => x.id)).toEqual(['other-legacy'])
  expect((await current.listSavedTasks()).map(x => x.id)).toEqual(['other-modern'])
})
