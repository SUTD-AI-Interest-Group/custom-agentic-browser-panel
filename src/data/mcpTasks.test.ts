import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import { claimMcpCompletion, deleteMcpTasks, getMcpTask, listMcpTasks, mcpConfigHash, updateMcpTask, type StoredMcpTask } from './mcpTasks'

export function record(id = 'one'): StoredMcpTask {
  return { id, conversationId: 'chat', server: 'srv', tool: 'job', configHash: 'hash', args: {}, createdAt: Date.now(), nextPollAt: 0,
    task: { taskId: id, status: 'completed', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttl: null }, ready: true }
}
beforeEach(async () => { vi.stubGlobal('crypto', webcrypto); await deleteMcpTasks() })
it('persists full results and conversation ownership', async () => {
  const value = { ...record(), result: { content: [{ type: 'text' as const, text: 'done' }], _meta: { widget: 1 } } }
  await updateMcpTask(value.id, () => value)
  expect(await getMcpTask(value.id)).toEqual(value)
})
it('atomically grants only one panel a completion lease', async () => {
  await updateMcpTask('one', () => record())
  const claims = await Promise.all([claimMcpCompletion('one', 'panel-a'), claimMcpCompletion('one', 'panel-b')])
  expect(claims.filter(Boolean)).toHaveLength(1)
})
it('recovers an expired lease but never redelivers acknowledged or stopped events', async () => {
  await updateMcpTask('one', () => ({ ...record(), lease: { owner: 'closed-panel', until: 0 } }))
  expect(await claimMcpCompletion('one', 'reopened')).toBeDefined()
  await updateMcpTask('one', (old) => ({ ...old!, lease: undefined, delivered: true }))
  expect(await claimMcpCompletion('one', 'reopened')).toBeUndefined()
  await updateMcpTask('one', (old) => ({ ...old!, delivered: false, suppressed: true }))
  expect(await claimMcpCompletion('one', 'reopened')).toBeUndefined()
})
it('merges independent status and stop writes without losing either', async () => {
  await updateMcpTask('one', () => record())
  await Promise.all([
    updateMcpTask('one', (old) => ({ ...old!, suppressed: true })),
    updateMcpTask('one', (old) => ({ ...old!, error: 'expired' })),
  ])
  expect(await getMcpTask('one')).toMatchObject({ suppressed: true, error: 'expired' })
})
it('deletes only tasks belonging to a deleted chat', async () => {
  await updateMcpTask('one', () => record())
  await updateMcpTask('two', () => ({ ...record('two'), conversationId: 'other' }))
  await deleteMcpTasks('chat')
  expect((await listMcpTasks()).map((x) => x.id)).toEqual(['two'])
})
it('binds headers and nested config without storing credentials, independent of key order', async () => {
  const a = { url: 'https://a.test', headers: { Authorization: 'secret', Z: '1' } }
  const same = { headers: { Z: '1', Authorization: 'secret' }, url: 'https://a.test' }
  expect(await mcpConfigHash(a)).toBe(await mcpConfigHash(same))
  expect(await mcpConfigHash(a)).not.toBe(await mcpConfigHash({ ...a, headers: { Authorization: 'other' } }))
  expect(await mcpConfigHash(a)).not.toContain('secret')
})
it('rejects an updater exception with its original cause and preserves the record', async () => {
  await updateMcpTask('one', () => record())
  const failure = new Error('Updater failed')
  await expect(updateMcpTask('one', () => { throw failure })).rejects.toBe(failure)
  expect((await getMcpTask('one'))?.id).toBe('one')
})
it('reports an uncloneable update without an uncaught transaction callback exception', async () => {
  await updateMcpTask('one', () => record())
  await expect(updateMcpTask('one', old => ({ ...old!, args: { invalid: () => {} } }))).rejects.toMatchObject({ name: 'DataCloneError' })
  expect((await getMcpTask('one'))?.args).toEqual({})
})
it('continues a queued completion after reconnecting the database', async () => {
  const saved = { ...record('v2-task'), result: { content: [{ type: 'text' as const, text: 'Existing result' }] } }
  await updateMcpTask(saved.id, () => saved)
  const { mcpTaskTransaction } = await import('./mcpTaskDatabase')
  const tx = await mcpTaskTransaction('sdkTasks')
  tx.db.close()
  expect(await getMcpTask(saved.id)).toEqual(saved)
  const claimed = await claimMcpCompletion(saved.id, 'new-panel')
  expect(claimed?.result).toEqual(saved.result)
  await updateMcpTask(saved.id, old => ({ ...old!, delivered: true, lease: undefined }))
  expect(await claimMcpCompletion(saved.id, 'another-panel')).toBeUndefined()
})
