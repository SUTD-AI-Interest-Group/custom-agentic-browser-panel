import { expect, test } from 'vitest'
import type { LanguageModelUsage } from 'ai'
import { formatTokens, hasTokens, sumUsage, toModelUsage, totalTokens } from './usage'

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

// toModelUsage: the raw AI SDK usage nests cache/reasoning figures under
// inputTokenDetails/outputTokenDetails; every ModelUsage field being optional
// meant assigning the raw shape straight into a ModelUsage-typed variable
// (what runAgentTurn used to do) type-checked fine while silently leaving
// cachedInputTokens/reasoningTokens undefined forever — nobody downstream
// (Langfuse's cache_read mapping, any future UI) ever saw a real number.
const rawUsage = (over: Partial<LanguageModelUsage> = {}): LanguageModelUsage => ({
  inputTokens: 100,
  inputTokenDetails: { noCacheTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0 },
  outputTokens: 10,
  outputTokenDetails: { textTokens: 10, reasoningTokens: 0 },
  totalTokens: 110,
  ...over,
})

test('toModelUsage pulls cachedInputTokens out of the nested inputTokenDetails', () => {
  expect(toModelUsage(rawUsage())).toEqual({
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 110,
    reasoningTokens: 0,
    cachedInputTokens: 80,
  })
})

test('toModelUsage pulls reasoningTokens out of the nested outputTokenDetails', () => {
  const u = rawUsage({ outputTokenDetails: { textTokens: 4, reasoningTokens: 6 } })
  expect(toModelUsage(u)?.reasoningTokens).toBe(6)
})

test('toModelUsage passes undefined through unchanged', () => {
  expect(toModelUsage(undefined)).toBeUndefined()
})

test('toModelUsage tolerates a usage object missing the detail sub-objects entirely', () => {
  // A non-Anthropic endpoint that reports only the top-level counts.
  const minimal = { inputTokens: 5, outputTokens: 2, totalTokens: 7 } as LanguageModelUsage
  expect(toModelUsage(minimal)).toEqual({
    inputTokens: 5,
    outputTokens: 2,
    totalTokens: 7,
    reasoningTokens: undefined,
    cachedInputTokens: undefined,
  })
})
