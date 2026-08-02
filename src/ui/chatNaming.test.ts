import { expect, test } from 'vitest'
import { shouldAttemptNaming } from './chatNaming'

// F7 (d11): the chat auto-naming effect's guard only checked `titled` (set
// after a call SUCCEEDS) and `tries >= maxTries` (an attempt COUNT, incremented
// as each attempt FIRES) — nothing tracked "an attempt is currently
// outstanding." A slow namer (queued behind a busy local model) racing a fast
// follow-up turn's own naming attempt could have two `generateChatTitle` calls
// in flight at once, with whichever resolved LAST winning non-deterministically
// (and overwriting an already-set, possibly-better title). `inFlight` closes
// the gap.

const base = { turnSeq: 1, titled: false, inFlight: false, tries: 0, maxTries: 3 }

test('attempts naming on a fresh, untitled, untried chat', () => {
  expect(shouldAttemptNaming(base)).toBe(true)
})

test('never attempts before any turn has finished (turnSeq 0)', () => {
  expect(shouldAttemptNaming({ ...base, turnSeq: 0 })).toBe(false)
})

test('never attempts once already titled', () => {
  expect(shouldAttemptNaming({ ...base, titled: true })).toBe(false)
})

test('never attempts while a previous call is still outstanding', () => {
  expect(shouldAttemptNaming({ ...base, inFlight: true })).toBe(false)
})

test('never attempts once the retry budget is exhausted', () => {
  expect(shouldAttemptNaming({ ...base, tries: 3 })).toBe(false)
  expect(shouldAttemptNaming({ ...base, tries: 4 })).toBe(false)
})
