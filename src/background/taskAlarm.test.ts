import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { syncTaskAlarm } from './taskAlarm'
beforeEach(() => vi.stubGlobal('chrome', { alarms: { get: vi.fn(async () => undefined), create: vi.fn(async () => {}), clear: vi.fn(async () => true) } }))
afterEach(() => vi.unstubAllGlobals())
it('disarms empty queues and creates an alarm when work arrives', async () => {
  await syncTaskAlarm('queue', false)
  expect(chrome.alarms.clear).toHaveBeenCalledWith('queue')
  expect(chrome.alarms.create).not.toHaveBeenCalled()
  await syncTaskAlarm('queue', true)
  expect(chrome.alarms.create).toHaveBeenCalledWith('queue', { delayInMinutes: 1, periodInMinutes: 1 })
})
it('does not postpone an existing alarm when work changes', async () => {
  vi.mocked(chrome.alarms.get).mockResolvedValue({ name: 'queue' } as chrome.alarms.Alarm)
  await syncTaskAlarm('queue', true)
  expect(chrome.alarms.create).not.toHaveBeenCalled()
})
