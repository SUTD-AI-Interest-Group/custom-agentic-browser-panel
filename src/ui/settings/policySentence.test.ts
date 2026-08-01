import { expect, test } from 'vitest'
import { policySentence } from './policySentence'

// The UI copy is *derived from* the policy value specifically so it cannot
// drift from the actual behavior (see the doc comment on policySentence
// itself) — pin down the exact phrasing per policy so a future edit to one
// without the other is caught immediately.

test('never', () => {
  expect(policySentence('never', 'Page reads')).toBe('Page reads are turned off.')
})

test('always', () => {
  expect(policySentence('always', 'Page reads')).toBe('Page reads run without asking.')
})

test('ask', () => {
  expect(policySentence('ask', 'Page reads')).toBe('Page reads ask for approval each time.')
})

test('the noun is substituted verbatim for a different caller (Lookups)', () => {
  expect(policySentence('ask', 'Lookups')).toBe('Lookups ask for approval each time.')
})
