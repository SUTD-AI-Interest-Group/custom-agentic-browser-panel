import 'fake-indexeddb/auto'
import { beforeEach, expect, it, vi } from 'vitest'
import { clearPageWatches, listPageWatches, updatePageWatch, validateWatch, watchInput, type PageWatch } from '../data/pageWatches'
import { pollPageWatches } from './pageWatches'
const mocks = vi.hoisted(() => ({ observe: vi.fn(), settings: { toolPolicies: {} as Record<string, string> } }))
vi.mock('../platform/pageWatch', () => ({ observeWatchTarget: mocks.observe }))
vi.mock('../data/settings', () => ({ loadSettings: async () => mocks.settings, toolPolicy: (s: typeof mocks.settings, n: string) => s.toolPolicies[n] ?? 'ask' }))
let record: PageWatch
let session: Record<string, unknown>
beforeEach(async () => {
  await clearPageWatches(); vi.clearAllMocks(); session = {}; mocks.settings.toolPolicies = {}
  record = { id: 'watch', conversationId: 'chat', url: 'https://example.test/', description: 'Registration opens', selector: '#register', condition: 'enabled', intervalSeconds: 60, deadline: new Date(Date.now() + 600000).toISOString(), deadlineAt: Date.now() + 600000, createdAt: Date.now(), nextCheckAt: 0, status: 'active', baseline: { text: 'Register', enabled: false, tag: 'BUTTON' } }
  vi.stubGlobal('chrome', {
    tabs: { create: vi.fn(async () => ({ id: 7 })), update: vi.fn(async () => ({})), get: vi.fn(async () => ({ id: 7, active: false, status: 'complete', url: record.url })), remove: vi.fn(async () => {}) },
    storage: { session: { get: vi.fn(async (key: string) => key ? ({ [key]: session[key] }) : session), set: async (value: object) => Object.assign(session, value), remove: async (key: string) => { delete session[key] } } },
    runtime: { getURL: (s: string) => s }, notifications: { create: vi.fn(async () => 'notice') },
  })
  mocks.observe.mockResolvedValue({ ...record.baseline, enabled: true })
  await updatePageWatch(record.id, () => record)
})
it('requires explicit timing, valid comparison text and stable target', () => {
  expect(watchInput.safeParse({ ...record, intervalSeconds: undefined }).success).toBe(false)
  expect(watchInput.safeParse({ ...record, deadline: undefined }).success).toBe(false)
  expect(() => validateWatch({ ...record, deadline: '2000-01-01T00:00:00Z' })).toThrow('future')
  expect(() => validateWatch({ ...record, condition: 'text_equals' })).toThrow('comparison text')
  expect(() => validateWatch({ ...record, selector: '[data-agent-region="1"]' })).toThrow('stable')
})
it('checks in an inactive temporary tab, notifies once, and closes it', async () => {
  await pollPageWatches(); await pollPageWatches()
  expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'about:blank', active: false })
  expect(chrome.tabs.remove).toHaveBeenCalledWith(7)
  expect(chrome.notifications.create).toHaveBeenCalledTimes(1)
  expect((await listPageWatches())[0]).toMatchObject({ status: 'matched', notified: true })
})
it('closes the new temporary tab if recording its ownership fails', async () => {
  vi.spyOn(chrome.storage.session, 'set').mockRejectedValueOnce(new Error('session storage unavailable'))
  await pollPageWatches()
  expect(chrome.tabs.remove).toHaveBeenCalledWith(7)
  expect((await listPageWatches())[0]).toMatchObject({ status: 'needs_attention' })
})
it('honors intervals and deadlines without replaying missed checks', async () => {
  mocks.observe.mockResolvedValue(record.baseline)
  await pollPageWatches(); await pollPageWatches()
  expect(mocks.observe).toHaveBeenCalledTimes(1)
  await updatePageWatch(record.id, old => ({ ...old!, deadlineAt: 0 }))
  await pollPageWatches()
  expect((await listPageWatches())[0].status).toBe('expired')
  expect(chrome.notifications.create).not.toHaveBeenCalled()
})
it('cancellation during a read suppresses a match notification', async () => {
  mocks.observe.mockImplementation(async () => { await updatePageWatch(record.id, old => ({ ...old!, status: 'cancelled' })); return { ...record.baseline, enabled: true } })
  await pollPageWatches()
  expect((await listPageWatches())[0].status).toBe('cancelled')
  expect(chrome.notifications.create).not.toHaveBeenCalled()
  expect(chrome.tabs.remove).toHaveBeenCalledWith(7)
})
it('deletion during a read cannot resurrect the watch', async () => {
  mocks.observe.mockImplementation(async () => { await clearPageWatches('chat'); return { ...record.baseline, enabled: true } })
  await pollPageWatches()
  expect(await listPageWatches()).toEqual([])
  expect(chrome.notifications.create).not.toHaveBeenCalled()
})
it('a redirected page needs attention instead of matching unrelated content', async () => {
  vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 7, active: false, status: 'complete', url: 'https://example.test/login' } as chrome.tabs.Tab)
  await pollPageWatches()
  expect((await listPageWatches())[0]).toMatchObject({ status: 'needs_attention' })
  expect(mocks.observe).not.toHaveBeenCalled()
})
it('Never policy stops scheduled activity', async () => {
  mocks.settings.toolPolicies.CreatePageWatch = 'never'
  await pollPageWatches()
  expect(chrome.tabs.create).not.toHaveBeenCalled()
  expect((await listPageWatches())[0].status).toBe('cancelled')
})
it('concurrent polling shares one check', async () => {
  await Promise.all([pollPageWatches(), pollPageWatches()])
  expect(mocks.observe).toHaveBeenCalledTimes(1)
})
it('does not close a temporary tab the user has activated', async () => {
  vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 7, active: true, status: 'complete', url: record.url } as chrome.tabs.Tab)
  await pollPageWatches()
  expect(chrome.tabs.remove).not.toHaveBeenCalled()
})
