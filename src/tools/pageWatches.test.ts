import 'fake-indexeddb/auto'
import { beforeEach, expect, it, vi } from 'vitest'
import { createPageWatchTools } from './pageWatches'
import { clearPageWatches, listPageWatches } from '../data/pageWatches'
const mocks = vi.hoisted(() => ({ observe: vi.fn(), shot: vi.fn() }))
vi.mock('../platform/pageWatch', () => ({ observeWatchTarget: mocks.observe }))
vi.mock('../data/screenshots', () => ({ getShot: mocks.shot }))
const input = () => ({ description: 'Opens', selector: '#register', condition: 'enabled', intervalSeconds: 60, deadline: new Date(Date.now() + 600000).toISOString() })
const options = (approved = true) => ({ conversationId: 'chat', resolveTab: async () => ({ id: 1, url: 'https://example.test/' } as chrome.tabs.Tab), approve: vi.fn(async () => approved) })
async function execute(name: string, value: unknown, approved = true) {
  const tool = createPageWatchTools(options(approved))[name]
  return await tool.execute!(value as never, {} as never) as any
}
beforeEach(async () => { await clearPageWatches(); vi.clearAllMocks(); mocks.observe.mockResolvedValue({ text: 'Register', enabled: false, tag: 'BUTTON' }) })
it('does not read a page or create a watch without approval', async () => {
  expect(await execute('CreatePageWatch', input(), false)).toHaveProperty('error')
  expect(mocks.observe).not.toHaveBeenCalled(); expect(await listPageWatches()).toEqual([])
})
it('rejects missing timing at execution even when schema validation is bypassed', async () => {
  expect(await execute('CreatePageWatch', { ...input(), intervalSeconds: undefined })).toHaveProperty('error')
  expect(await listPageWatches()).toEqual([])
})
it('accepts same-page component screenshot context and rejects foreign screenshots', async () => {
  mocks.shot.mockResolvedValue({ conversationId: 'other', url: 'https://example.test/' })
  expect(await execute('CreatePageWatch', { ...input(), screenshotId: 'shot' })).toHaveProperty('error')
  mocks.shot.mockResolvedValue({ conversationId: 'chat', url: 'https://example.test/' })
  expect(await execute('CreatePageWatch', { ...input(), screenshotId: 'shot' })).toHaveProperty('watchId')
  expect((await listPageWatches())[0].screenshotId).toBe('shot')
})
it('reports an already matching condition without creating a watch', async () => {
  mocks.observe.mockResolvedValue({ text: 'Register', enabled: true, tag: 'BUTTON' })
  expect(await execute('CreatePageWatch', input())).toMatchObject({ alreadyMatches: true })
  expect(await listPageWatches()).toEqual([])
})
it('lists and cancels watches only in their owning conversation', async () => {
  const created = await execute('CreatePageWatch', input())
  const foreign = createPageWatchTools({ ...options(), conversationId: 'other' })
  expect(await foreign.CancelPageWatch.execute!({ watchId: created.watchId }, {} as never)).toEqual({ cancelled: false })
  expect(await execute('CancelPageWatch', { watchId: created.watchId })).toEqual({ cancelled: true })
  expect((await listPageWatches())[0].status).toBe('cancelled')
})
