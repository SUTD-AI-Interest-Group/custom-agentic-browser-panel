import { expect, test } from 'vitest'
import { createAttachReservation } from './attachReservation'

// d06 F6 (reassigned to Chat.tsx): MAX_ATTACHMENTS was enforced only against a
// stale `attachments.length` snapshot read before `await ingestFiles(...)` — a
// multi-file PDF/image batch that takes real wall-clock time to parse. A second
// addFiles call (a paste landing before an earlier drop's batch resolves) read
// the SAME pre-update count (React state hadn't committed yet) and could jointly
// exceed the cap. createAttachReservation tracks files from batches still being
// ingested so a concurrent batch's baseline includes them.

test('a lone batch is reserved against nothing else in flight', () => {
  const res = createAttachReservation()
  expect(res.reserve(0, 10)).toBe(0)
})

test('a second batch reserved before the first settles sees the first\'s files as already counted', () => {
  const res = createAttachReservation()
  const baselineA = res.reserve(0, 10) // e.g. a 10-file drop, still parsing
  expect(baselineA).toBe(0) // nothing committed yet, nothing else in flight
  // attachments.length is STILL 0 here — batch A's setAttachments hasn't
  // landed — which is exactly the stale snapshot the bug read directly.
  const baselineB = res.reserve(0, 1) // a paste landing before A resolves
  expect(baselineB).toBe(10) // but B must see A's 10 reserved files
  res.release(10)
  res.release(1)
})

test('releasing a batch frees its reservation for the next one', () => {
  const res = createAttachReservation()
  res.reserve(0, 10)
  res.release(10)
  expect(res.reserve(0, 1)).toBe(0)
})

// Reproduces the actual bug shape end-to-end against ingestFiles's own cap
// arithmetic (existingCount + acceptedSoFar >= MAX_ATTACHMENTS), without
// importing ingestFiles itself (Chrome/FileReader/pdf.js-coupled) — this
// mirrors just its accept-up-to-the-cap rule.
function acceptedFor(existingCount: number, fileCount: number, cap: number): number {
  return Math.max(0, Math.min(fileCount, cap - existingCount))
}

test('two overlapping batches never jointly accept more than the cap', () => {
  const cap = 10
  const res = createAttachReservation()

  const baselineA = res.reserve(0, 10) // a 10-file drop
  const acceptedA = acceptedFor(baselineA, 10, cap)
  const baselineB = res.reserve(0, 1) // a 1-file paste, before A commits
  const acceptedB = acceptedFor(baselineB, 1, cap)
  res.release(10)
  res.release(1)

  expect(acceptedA).toBe(10)
  expect(acceptedB).toBe(0)
  expect(acceptedA + acceptedB).toBeLessThanOrEqual(cap)
})
