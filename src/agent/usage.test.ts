import { expect, test } from 'vitest'
import { formatTokens, hasTokens, sumUsage, totalTokens } from './usage'

test('sumUsage rolls continuation cycles together', () => {
  expect(sumUsage(undefined, undefined)).toBeUndefined()
  // A cycle that reported nothing must not erase one that did.
  expect(sumUsage({ inputTokens: 10 }, undefined)).toEqual({ inputTokens: 10 })
  expect(sumUsage(undefined, { inputTokens: 10 })).toEqual({ inputTokens: 10 })
  expect(
    sumUsage(
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    ),
  ).toEqual({
    inputTokens: 13,
    outputTokens: 7,
    totalTokens: 20,
    reasoningTokens: undefined,
    cachedInputTokens: undefined,
  })
})

test('totalTokens falls back to input+output when the endpoint omits a total', () => {
  expect(totalTokens({ inputTokens: 10, outputTokens: 5 })).toBe(15)
  expect(totalTokens({ inputTokens: 10, outputTokens: 5, totalTokens: 99 })).toBe(99)
  expect(totalTokens(undefined)).toBe(0)
})

test('hasTokens is false for an endpoint that reported nothing', () => {
  // The whole point: show nothing rather than a misleading "0 tok".
  expect(hasTokens(undefined)).toBe(false)
  expect(hasTokens({})).toBe(false)
  expect(hasTokens({ inputTokens: 0, outputTokens: 0 })).toBe(false)
  expect(hasTokens({ inputTokens: 12 })).toBe(true)
})

test('formatting stays compact', () => {
  expect(formatTokens(1240)).toBe('1,240')
  expect(formatTokens(16_200)).toBe('16.2k')
  expect(formatTokens(20_000)).toBe('20k')
})
