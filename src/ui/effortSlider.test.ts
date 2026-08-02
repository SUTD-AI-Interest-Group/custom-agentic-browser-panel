import { expect, test } from 'vitest'
import { resolveEffortSlider } from './effortSlider'

const FOUR = ['none', 'low', 'medium', 'high'] as const

test('mid-range case resolves the matching index and a proportional percent', () => {
  expect(resolveEffortSlider([...FOUR], 'medium')).toEqual({ index: 2, pct: (2 / 3) * 100 })
})

test('the first level is index 0 / 0%, the last is 100%', () => {
  expect(resolveEffortSlider([...FOUR], 'none')).toEqual({ index: 0, pct: 0 })
  expect(resolveEffortSlider([...FOUR], 'high')).toEqual({ index: 3, pct: 100 })
})

test('current undefined defaults to index 0', () => {
  expect(resolveEffortSlider([...FOUR], undefined)).toEqual({ index: 0, pct: 0 })
})

// A stored effort that no longer appears in the model's rungs (e.g. a
// provider profile changed, or a per-model override was set while a
// different model was selected) must clamp rather than crash on indexOf
// returning -1.
test('a current value absent from levels clamps to index 0 instead of going negative', () => {
  expect(resolveEffortSlider([...FOUR], 'xhigh')).toEqual({ index: 0, pct: 0 })
})

test('a single-level array never divides by zero', () => {
  expect(resolveEffortSlider(['high'], 'high')).toEqual({ index: 0, pct: 0 })
})

test('an empty levels array is handled without throwing', () => {
  expect(resolveEffortSlider([], undefined)).toEqual({ index: 0, pct: 0 })
})
