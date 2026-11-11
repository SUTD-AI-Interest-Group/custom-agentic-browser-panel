import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { elicitationQueue } from '../mcp/elicitation'
import { installElicitationBridge } from './elicitationBridge'
let listener: (message: unknown, sender: unknown, reply: (value: any) => void) => void
let dispose: () => void, controller: AbortController
const panel = { id: 'extension', url: 'chrome-extension://extension/sidepanel.html' }
beforeEach(() => {
  controller = new AbortController()
  vi.stubGlobal('chrome', { runtime: {
    id: 'extension', getURL: (file: string) => `chrome-extension://extension/${file}`,
    sendMessage: vi.fn(async () => ({})),
    onMessage: { addListener: vi.fn(fn => { listener = fn }), removeListener: vi.fn() },
  } })
  dispose = installElicitationBridge()
})
afterEach(() => { controller.abort(); dispose(); vi.unstubAllGlobals() })
it('reattaches a panel to worker clarification and accepts only a valid explicit response', async () => {
  const pending = elicitationQueue.ask('server', { message: 'Choose', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }, controller.signal)
  let result: any
  listener({ type: 'mcp.elicitation.list' }, panel, value => { result = value })
  expect(result.entries).toHaveLength(1)
  expect(Object.keys(result.entries[0]).sort()).toEqual(['id', 'request', 'server'])
  expect(() => structuredClone(result)).not.toThrow()
  const id = result.entries[0].id
  listener({ type: 'mcp.elicitation.respond', id, reply: { action: 'accept', content: {} } }, panel, value => { result = value })
  expect(result.error).toBeTruthy()
  expect(elicitationQueue.snapshot()).toHaveLength(1)
  listener({ type: 'mcp.elicitation.respond', id, reply: { action: 'accept', content: { name: 'Chosen by user' } } }, panel, value => { result = value })
  expect(result.ok).toBe(true)
  await expect(pending).resolves.toEqual({ action: 'accept', content: { name: 'Chosen by user' } })
  expect(elicitationQueue.snapshot()).toHaveLength(0)
})
it('refuses content scripts and foreign senders and removes listeners on teardown', () => {
  const reply = vi.fn()
  for (const sender of [{ id: 'foreign', url: panel.url }, { id: panel.id, url: 'https://example.test/' }]) {
    listener({ type: 'mcp.elicitation.list' }, sender, reply)
    listener({ type: 'mcp.elicitation.respond', id: 'missing', reply: { action: 'accept' } }, sender, reply)
  }
  expect(reply).not.toHaveBeenCalled()
  dispose()
  expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledWith(listener)
})
it('removes an outstanding clarification immediately when its tool is cancelled', async () => {
  const pending = elicitationQueue.ask('server', { message: 'Confirm', requestedSchema: { type: 'object', properties: {} } }, controller.signal).catch(error => error)
  controller.abort()
  await pending
  expect(elicitationQueue.snapshot()).toHaveLength(0)
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'mcp.elicitation.changed' })
})
