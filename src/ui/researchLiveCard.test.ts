import { expect, test } from 'vitest'
import { formatElapsed } from './ResearchLiveCard'

test('shows seconds under a minute', () => {
  expect(formatElapsed(0)).toBe('0s')
  expect(formatElapsed(45_000)).toBe('45s')
  expect(formatElapsed(59_999)).toBe('59s')
})

test('shows whole minutes under an hour, truncating rather than rounding', () => {
  expect(formatElapsed(60_000)).toBe('1m')
  // 8m59s must read as 8m, not 9m — a research card that claims more elapsed
  // time than has actually passed is the wrong direction to be wrong in.
  expect(formatElapsed(8 * 60_000 + 59_000)).toBe('8m')
  expect(formatElapsed(59 * 60_000)).toBe('59m')
})

test('splits into hours and minutes past the hour', () => {
  expect(formatElapsed(60 * 60_000)).toBe('1h 0m')
  expect(formatElapsed(64 * 60_000)).toBe('1h 4m')
  // Research runs to a 24h deadline, so the format has to survive that long.
  expect(formatElapsed(24 * 60 * 60_000)).toBe('24h 0m')
})

// A task's startedAt is persisted and the clock is the panel's own; a reload
// during a clock adjustment can hand this a negative interval. Clamping keeps
// the card showing "0s" rather than "-1s" or NaN.
test('clamps a negative interval to zero rather than rendering nonsense', () => {
  expect(formatElapsed(-5000)).toBe('0s')
})
