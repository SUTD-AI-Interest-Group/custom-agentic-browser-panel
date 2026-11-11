import { afterEach, expect, it, vi } from 'vitest'
import { changeMailbox, createChangeSignal, observeChanges } from './changeSignal'

afterEach(() => vi.useRealTimers())

it('delivers same-context changes and ignores unrelated keys', async () => {
  const signal = createChangeSignal('test-local')
  const mailbox = changeMailbox(signal, 'chat')
  let woken = false
  const waiting = mailbox.wait(1000).then(() => { woken = true })
  signal.publish('other')
  await Promise.resolve()
  expect(woken).toBe(false)
  signal.publish('chat')
  await waiting
  expect(woken).toBe(true)
  mailbox.close()
})

it('does not lose an invalidation arriving between read and wait', async () => {
  vi.useFakeTimers()
  const signal = createChangeSignal('test-race')
  const mailbox = changeMailbox(signal, 'chat')
  signal.publish('chat')
  await mailbox.wait(5000)
  expect(vi.getTimerCount()).toBe(0)
  mailbox.close()
})

it('wakes and clears the fallback timer when disposed', async () => {
  vi.useFakeTimers()
  const mailbox = changeMailbox(createChangeSignal('test-dispose'), 'chat')
  const waiting = mailbox.wait(5000)
  mailbox.close()
  await waiting
  expect(vi.getTimerCount()).toBe(0)
})

it('coalesces bursts and never overlaps reads, including changes during a read', async () => {
  const signal = createChangeSignal('test-observer')
  let finish!: () => void
  const read = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve })).mockResolvedValue(undefined)
  const stop = observeChanges(signal, 'chat', read)
  signal.publish('chat')
  signal.publish('chat')
  expect(read).toHaveBeenCalledTimes(1)
  finish()
  await Promise.resolve()
  await Promise.resolve()
  expect(read).toHaveBeenCalledTimes(2)
  stop()
  signal.publish('chat')
  expect(read).toHaveBeenCalledTimes(2)
})

it('delivers invalidations between independent browser contexts', async () => {
  const first = createChangeSignal('test-cross-context')
  const second = createChangeSignal('test-cross-context')
  const mailbox = changeMailbox(second, 'chat')
  const received = new Promise<string>(resolve => {
    const unsubscribe = second.subscribe(key => { unsubscribe(); resolve(key) })
  })
  first.publish('chat')
  expect(await received).toBe('chat')
  mailbox.close()
})
