import { expect, test } from 'vitest'
import { ApprovalQueue, MIN_VISIBLE_MS } from './approvalQueue'

interface Req {
  toolName: string
}

test('a second request() while the first is still pending must not prevent the first from eventually resolving', async () => {
  const queue = new ApprovalQueue<Req>()
  const first = queue.request({ toolName: 'RunCode' }, 0)
  const second = queue.request({ toolName: 'CreateArtifact' }, 0)

  // The second call must queue behind the first, not clobber it — the first
  // request is still what's shown to the user.
  expect(queue.front?.toolName).toBe('RunCode')

  // Resolving the currently-surfaced request (once its grace period has
  // elapsed) must reveal the second one, and resolving that must, in turn,
  // empty the queue. Both callers' promises must settle with the verdict
  // they were actually given.
  const idA = queue.frontId!
  const afterFirst = queue.settle(idA, true, MIN_VISIBLE_MS)
  expect(afterFirst).toEqual({ settled: true, front: { toolName: 'CreateArtifact' } })

  const idB = queue.frontId!
  const afterSecond = queue.settle(idB, false, MIN_VISIBLE_MS * 2)
  expect(afterSecond).toEqual({ settled: true, front: null })

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
  queue.request({ toolName: 'A' }, 0)
  queue.request({ toolName: 'B' }, 0)
  queue.request({ toolName: 'C' }, 0)
  expect(queue.front?.toolName).toBe('A')

  let t = MIN_VISIBLE_MS
  let id = queue.frontId!
  expect(queue.settle(id, true, t).front?.toolName).toBe('B')

  t += MIN_VISIBLE_MS
  id = queue.frontId!
  expect(queue.settle(id, true, t).front?.toolName).toBe('C')

  t += MIN_VISIBLE_MS
  id = queue.frontId!
  expect(queue.settle(id, true, t).front).toBeNull()
  expect(queue.size).toBe(0)
})

test('settle on an empty queue is a harmless no-op', () => {
  const queue = new ApprovalQueue<Req>()
  expect(queue.settle(0, true)).toEqual({ settled: false, front: null })
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

// --- R3 regression coverage: settle-by-identity ---------------------------
//
// An earlier wave (FIFO queue) fixed a second concurrent request clobbering
// the first's resolve callback. The adversarial regression review found a
// narrower gap in that fix: settleFront() always applied its verdict to
// "whatever is currently at the front", trusting the caller's belief about
// what that is. A rapid double-click meant for card A could settle card B —
// the card that slid into view the instant A was dismissed — without the
// user ever having seen or answered it. That's a consent-integrity bug: an
// unseen card must never be auto-answered.

test('a settle whose id no longer matches the front is rejected, not silently applied to the new front', async () => {
  const queue = new ApprovalQueue<Req>()
  const first = queue.request({ toolName: 'RunCode' }, 0)
  const second = queue.request({ toolName: 'CreateArtifact' }, 0)
  const staleId = queue.frontId! // captured while RunCode is still the front

  // RunCode settles — front advances to CreateArtifact...
  queue.settle(staleId, true, MIN_VISIBLE_MS)
  expect(queue.front?.toolName).toBe('CreateArtifact')

  // ...and a SECOND call using the SAME (now stale) id — e.g. a double-click
  // whose second event fired before React re-rendered — must not reach
  // CreateArtifact just because it's now the front.
  const result = queue.settle(staleId, true, MIN_VISIBLE_MS * 2)
  expect(result).toEqual({ settled: false, front: { toolName: 'CreateArtifact' } })

  await expect(first).resolves.toBe(true)
  // CreateArtifact must still be genuinely unresolved — it only settles later,
  // on its own, with its own (correct) id.
  const idB = queue.frontId!
  queue.settle(idB, false, MIN_VISIBLE_MS * 3)
  await expect(second).resolves.toBe(false)
})

test('a settle arriving less than MIN_VISIBLE_MS after its card became the front is rejected — the double-click guard', () => {
  const queue = new ApprovalQueue<Req>()
  queue.request({ toolName: 'Solo' }, 1_000)
  const id = queue.frontId!

  // The id IS correct here — this models the second click of a literal
  // double-click landing on the card that only just replaced the previous
  // one, a fresh (not stale) click that the id check alone can't catch.
  const tooSoon = queue.settle(id, true, 1_000 + MIN_VISIBLE_MS - 1)
  expect(tooSoon).toEqual({ settled: false, front: { toolName: 'Solo' } })

  const onTime = queue.settle(id, true, 1_000 + MIN_VISIBLE_MS)
  expect(onTime).toEqual({ settled: true, front: null })
})

test('the double-click guard re-arms for whichever card newly becomes the front, not just the very first', () => {
  const queue = new ApprovalQueue<Req>()
  queue.request({ toolName: 'A' }, 0)
  queue.request({ toolName: 'B' }, 0)
  const idA = queue.frontId!
  queue.settle(idA, true, MIN_VISIBLE_MS) // A settles; B becomes the front at t=MIN_VISIBLE_MS

  const idB = queue.frontId!
  // A rapid second click landing right as B slides into view — the same
  // timing gap all over again, now against B.
  const immediate = queue.settle(idB, true, MIN_VISIBLE_MS + 1)
  expect(immediate).toEqual({ settled: false, front: { toolName: 'B' } })

  const later = queue.settle(idB, true, MIN_VISIBLE_MS + MIN_VISIBLE_MS)
  expect(later).toEqual({ settled: true, front: null })
})

test('frontId is null when the queue is empty, and stays the same id while a request sits queued behind the front', () => {
  const queue = new ApprovalQueue<Req>()
  expect(queue.frontId).toBeNull()
  queue.request({ toolName: 'A' })
  const idA = queue.frontId
  expect(idA).not.toBeNull()
  queue.request({ toolName: 'B' })
  expect(queue.frontId).toBe(idA) // still A up front; B is merely queued
})

test('drainAll bypasses both the identity and grace-period checks — it is a hard stop, not an answer to any one card', async () => {
  const queue = new ApprovalQueue<Req>()
  const a = queue.request({ toolName: 'A' }, 0)
  queue.drainAll(false) // settled instantly, well within MIN_VISIBLE_MS of becoming front
  await expect(a).resolves.toBe(false)
})
