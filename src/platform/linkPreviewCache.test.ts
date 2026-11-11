import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../data/settings', () => ({ loadSettings: vi.fn(async () => ({ fetchLinkPreviews: true })) }))
import { loadSettings } from '../data/settings'
import { getLinkPreview } from './linkPreview'
let reads: ReturnType<typeof vi.fn>
let fetcher: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.mocked(loadSettings).mockResolvedValue({ fetchLinkPreviews: true } as any)
  reads = vi.fn(async () => ({}))
  fetcher = vi.fn(async () => new Response('<title>Preview</title>', { headers: { 'content-type': 'text/html' } }))
  vi.stubGlobal('chrome', { storage: { local: { get: reads, set: vi.fn(async () => {}) } } })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it('coalesces simultaneous requests and honours disabling previews even for cached URLs', async () => {
  const url = 'https://example.com/coalesced'
  const results = await Promise.all(Array.from({ length: 8 }, () => getLinkPreview(url)))
  expect(results.every(result => result?.title === 'Preview')).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(reads).toHaveBeenCalledTimes(1)
  vi.mocked(loadSettings).mockResolvedValue({ fetchLinkPreviews: false } as any)
  expect(await getLinkPreview(url)).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('evicts the oldest unused entry instead of retaining every visited URL', async () => {
  const first = 'https://example.com/evict/first'
  await getLinkPreview(first)
  for (let index = 0; index < 128; index++) await getLinkPreview(`https://example.com/evict/${index}`)
  const before = fetcher.mock.calls.length
  await getLinkPreview('https://example.com/evict/127')
  expect(fetcher).toHaveBeenCalledTimes(before)
  await getLinkPreview(first)
  expect(fetcher).toHaveBeenCalledTimes(before + 1)
})
