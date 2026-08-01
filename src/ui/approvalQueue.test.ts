import { expect, test } from 'vitest'
import { ApprovalQueue } from './approvalQueue'

interface Req {
  toolName: string
}

test('a second request() while the first is still pending must not prevent the first from eventually resolving', async () => {
  const queue = new ApprovalQueue<Req>()
  const first = queue.request({ toolName: 'RunCode' })
  const second = queue.request({ toolName: 'CreateArtifact' })

  // The second call must queue behind the first, not clobber it — the first
  // request is still what's shown to the user.
  expect(queue.front?.toolName).toBe('RunCode')

  // Resolving the currently-surfaced request must reveal the second one, and
  // resolving that must, in turn, empty the queue. Both callers' promises
  // must settle with the verdict they were actually given.
  expect(queue.settleFront(true)?.toolName).toBe('CreateArtifact')
  expect(queue.settleFront(false)).toBeNull()
  await expect(first).resolves.toBe(true)
  await expect(second).resolves.toBe(false)
})

test('a request arriving when the queue is empty becomes the front immediately', () => {
  const queue = new ApprovalQueue<Req>()
  queue.request({ toolName: 'Solo' })
  expect(queue.front?.toolName).toBe('Solo')
  expect(queue.size).toBe(1)
})

test('three queued requests settle strictly in FIFO order', () => {
  const queue = new ApprovalQueue<Req>()
  queue.request({ toolName: 'A' })
  queue.request({ toolName: 'B' })
  queue.request({ toolName: 'C' })
  expect(queue.front?.toolName).toBe('A')
  expect(queue.settleFront(true)?.toolName).toBe('B')
  expect(queue.settleFront(true)?.toolName).toBe('C')
  expect(queue.settleFront(true)).toBeNull()
  expect(queue.size).toBe(0)
})

test('settleFront on an empty queue is a harmless no-op', () => {
  const queue = new ApprovalQueue<Req>()
  expect(queue.settleFront(true)).toBeNull()
  expect(queue.front).toBeNull()
})

test('drainAll resolves every pending request — front and everything queued behind it — and empties the queue', async () => {
  const queue = new ApprovalQueue<Req>()
  const a = queue.request({ toolName: 'A' })
  const b = queue.request({ toolName: 'B' })
  const c = queue.request({ toolName: 'C' })

  queue.drainAll(false)

  await expect(a).resolves.toBe(false)
  await expect(b).resolves.toBe(false)
  await expect(c).resolves.toBe(false)
  expect(queue.front).toBeNull()
  expect(queue.size).toBe(0)
})

test('drainAll on an empty queue is a harmless no-op', () => {
  const queue = new ApprovalQueue<Req>()
  expect(() => queue.drainAll(false)).not.toThrow()
  expect(queue.size).toBe(0)
})
