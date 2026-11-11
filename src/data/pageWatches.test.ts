import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { clearPageWatches, listPageWatches, updatePageWatch, type PageWatch } from './pageWatches'

it('aborts a failing mutation without poisoning later page-watch writes', async () => {
  await clearPageWatches()
  const watch: PageWatch = { id: 'w', conversationId: 'chat', url: 'https://example.com', description: 'Watch', selector: '#target', condition: 'enabled', intervalSeconds: 60, deadline: new Date(Date.now() + 60000).toISOString(), createdAt: 1, deadlineAt: Date.now() + 60000, nextCheckAt: 1, status: 'active', baseline: { text: '', enabled: false, tag: 'button' } }
  await updatePageWatch('w', () => watch)
  await expect(updatePageWatch('w', () => { throw new Error('bad mutation') })).rejects.toThrow('bad mutation')
  expect((await listPageWatches())[0].status).toBe('active')
  await updatePageWatch('w', old => ({ ...old!, status: 'cancelled' }))
  expect((await listPageWatches())[0].status).toBe('cancelled')
  await clearPageWatches()
})
