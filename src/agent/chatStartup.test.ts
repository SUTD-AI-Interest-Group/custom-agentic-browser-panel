import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startChatRun } from './chatStartup'
import { getChatRun } from '../data/chatRuns'
vi.mock('../data/chatRuns', () => ({ getChatRun: vi.fn() }))
const send = vi.fn()
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } })
  vi.mocked(getChatRun).mockResolvedValue({ id: 'run', state: 'queued' } as never)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('chat startup acknowledgement', () => {
  it('accepts only an acknowledgement for this run', async () => {
    send.mockResolvedValue({ ok: true, id: 'run' })
    await startChatRun('chat', 'run')
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('recovers a lost reply when the host already started without redispatch', async () => {
    send.mockResolvedValue(undefined)
    vi.mocked(getChatRun).mockResolvedValue({ id: 'run', state: 'running' } as never)
    await startChatRun('chat', 'run')
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('retries delivery using the same run ID', async () => {
    send.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ ok: true, id: 'run' })
    const started = startChatRun('chat', 'run')
    await vi.runAllTimersAsync(); await started
    expect(send.mock.calls).toEqual([
      [{ type: 'chat.start', conversationId: 'chat', id: 'run' }],
      [{ type: 'chat.start', conversationId: 'chat', id: 'run' }],
    ])
  })
  it('explains extension reload when an old worker replies without handling the message', async () => {
    send.mockResolvedValue(undefined)
    const failure = expect(startChatRun('chat', 'run')).rejects.toThrow('Closing and reopening the panel alone does not reload the extension')
    await vi.runAllTimersAsync(); await failure
  })
  it('retains the underlying host failure in the diagnostic', async () => {
    send.mockResolvedValue({ error: 'Offscreen API unavailable' })
    const failure = expect(startChatRun('chat', 'run')).rejects.toThrow('Offscreen API unavailable')
    await vi.runAllTimersAsync(); await failure
  })
  it('does not overwrite a completed or failed run when its reply is lost', async () => {
    send.mockResolvedValue(undefined)
    vi.mocked(getChatRun).mockResolvedValue({ id: 'run', state: 'error' } as never)
    await startChatRun('chat', 'run')
    expect(send).toHaveBeenCalledTimes(1)
  })
})
