import { expect, it, vi, afterEach } from 'vitest'
vi.mock('./webmcp', () => ({ discoverWebMcp: vi.fn() }))
import { discoverWebMcp } from './webmcp'
import { installWebMcpBadge } from './webmcpBadge'
afterEach(() => vi.unstubAllGlobals())
it('shows a per-tab badge when closed, clears it when open or tools disappear, and resets on navigation', async () => {
  let opened = false
  const tab = { id: 2, windowId: 3, url: 'https://example.com/' }
  const updated = vi.fn()
  const setBadgeText = vi.fn(async () => {})
  vi.stubGlobal('chrome', {
    tabs: { query: vi.fn(async () => [tab]), get: vi.fn(async () => tab), onRemoved: { addListener: vi.fn() }, onUpdated: { addListener: updated }, onActivated: { addListener: vi.fn() } },
    runtime: { onMessage: { addListener: vi.fn() } },
    action: { setBadgeText, setBadgeBackgroundColor: vi.fn(async () => {}), setTitle: vi.fn(async () => {}) },
  })
  vi.mocked(discoverWebMcp).mockResolvedValue({ url: tab.url, tools: [{ name: 'find', description: 'Find', inputSchema: {} }] })
  const refresh = installWebMcpBadge(() => opened)
  await refresh(3)
  expect(setBadgeText).toHaveBeenLastCalledWith({ tabId: 2, text: '1' })
  opened = true
  await refresh(3)
  expect(setBadgeText).toHaveBeenLastCalledWith({ tabId: 2, text: '' })
  opened = false
  vi.mocked(discoverWebMcp).mockResolvedValue({ url: tab.url, tools: [] })
  await refresh(3)
  expect(setBadgeText).toHaveBeenLastCalledWith({ tabId: 2, text: '' })
  updated.mock.calls[0][0](2, { status: 'loading' }, tab)
  expect(setBadgeText).toHaveBeenLastCalledWith({ tabId: 2, text: '' })
})
