import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WebMcpWelcome } from './WebMcpWelcome'
import { discoverWebMcp } from '../platform/webmcp'
import { generateWebMcpSuggestions } from '../agent/webmcpSuggestions'
vi.mock('../platform/webmcp', () => ({ discoverWebMcp: vi.fn() }))
vi.mock('../agent/provider', () => ({ createModel: vi.fn(() => ({})) }))
vi.mock('../agent/webmcpSuggestions', () => ({ generateWebMcpSuggestions: vi.fn() }))
let root: Root
let host: HTMLDivElement
const selected = { provider: { id: 'test', name: 'Test', baseURL: 'http://localhost', apiKey: '', models: ['model'] }, modelId: 'model' }
const action = { name: 'find_items', description: 'Find products', inputSchema: {} }
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  vi.mocked(discoverWebMcp).mockResolvedValue({ url: 'https://example.com/', tools: [action] })
  vi.mocked(generateWebMcpSuggestions).mockResolvedValue([{ prompt: 'Find some tea', toolNames: ['find_items'] }])
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })
async function render(onChoose = vi.fn(), url = 'https://example.com/') {
  await act(async () => root.render(createElement(WebMcpWelcome, { tabId: 2, url, selected, onChoose, children: 'How can I help?' })))
}
it('replaces helper text with actions and generated examples; click only prefills the composer', async () => {
  const choose = vi.fn()
  await render(choose)
  expect(host.textContent).toContain('Find products')
  expect(host.textContent).not.toContain('How can I help?')
  await act(async () => { await vi.advanceTimersByTimeAsync(601) })
  expect(host.textContent).toContain('Find some tea')
  await act(async () => host.querySelector<HTMLButtonElement>('.webmcp-examples button')!.click())
  expect(choose).toHaveBeenCalledWith(expect.stringContaining('Find some tea'))
})
it('returns to the helper text when tools are unregistered', async () => {
  await render()
  vi.mocked(discoverWebMcp).mockResolvedValue({ url: 'https://example.com/', tools: [] })
  await act(async () => { await vi.advanceTimersByTimeAsync(4001) })
  expect(host.textContent).toBe('How can I help?')
})
it('ignores late suggestions after navigating and aborts the old request', async () => {
  let complete!: (value: any) => void
  vi.mocked(generateWebMcpSuggestions).mockImplementation(() => new Promise(resolve => { complete = resolve }))
  await render()
  await act(async () => { await vi.advanceTimersByTimeAsync(601) })
  const signal = vi.mocked(generateWebMcpSuggestions).mock.calls[0][2]
  vi.mocked(discoverWebMcp).mockResolvedValue({ url: 'https://other.example/', tools: [] })
  await render(vi.fn(), 'https://other.example/')
  expect(signal.aborted).toBe(true)
  await act(async () => complete([{ prompt: 'Stale idea', toolNames: ['find_items'] }]))
  expect(host.textContent).not.toContain('Stale idea')
})
