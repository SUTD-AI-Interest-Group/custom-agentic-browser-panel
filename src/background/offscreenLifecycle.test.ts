import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { withOffscreen, closeOffscreenIfIdle } from './offscreenLifecycle'
let exists: boolean
beforeEach(() => {
  exists = false
  vi.stubGlobal('chrome', {
    offscreen: {
      hasDocument: vi.fn(async () => exists),
      createDocument: vi.fn(async () => { exists = true }),
      closeDocument: vi.fn(async () => { exists = false }),
      Reason: { DOM_PARSER: 'DOM_PARSER' },
    },
    runtime: { sendMessage: vi.fn(async () => ({ busy: false })) },
  })
})
afterEach(() => vi.unstubAllGlobals())
it('shares creation and serializes dispatch before a requested close', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const first = withOffscreen(() => gate)
  const second = withOffscreen(async () => 'second')
  const closing = closeOffscreenIfIdle()
  await vi.waitFor(() => expect(chrome.offscreen.createDocument).toHaveBeenCalledTimes(1))
  expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled()
  release()
  await first; expect(await second).toBe('second'); await closing
  expect(chrome.offscreen.closeDocument).toHaveBeenCalledTimes(1)
})
it('recreates the document for a dispatch racing after close', async () => {
  exists = true
  const closing = closeOffscreenIfIdle()
  const dispatched = withOffscreen(async () => expect(exists).toBe(true))
  await closing; await dispatched
  expect(chrome.offscreen.closeDocument).toHaveBeenCalledTimes(1)
  expect(chrome.offscreen.createDocument).toHaveBeenCalledTimes(1)
})
it('keeps a live tenant and recovers after a failed dispatch', async () => {
  await expect(withOffscreen(async () => { throw new Error('dispatch failed') })).rejects.toThrow('dispatch failed')
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValueOnce({ busy: true })
  await closeOffscreenIfIdle()
  expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled()
  await closeOffscreenIfIdle()
  expect(chrome.offscreen.closeDocument).toHaveBeenCalledTimes(1)
})
