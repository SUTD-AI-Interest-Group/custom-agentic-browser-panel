import { expect, test } from 'vitest'
import { sanitizeTitle } from './title'

test('takes the first line and strips wrapping punctuation', () => {
  expect(sanitizeTitle('Gauss Law Charge Distributions')).toBe('Gauss Law Charge Distributions')
  expect(sanitizeTitle('"Open Source vs Paid Models"')).toBe('Open Source vs Paid Models')
  expect(sanitizeTitle('“A Simple Greeting.”')).toBe('A Simple Greeting')
})

// A reasoning model's content part arrives with the leading blank lines its
// chat template emits after the thinking block — verbatim from LM Studio.
test('survives the leading newlines a reasoning model emits', () => {
  expect(sanitizeTitle('\n\nGauss Law Symmetry Examples')).toBe('Gauss Law Symmetry Examples')
})

// A chatty model prefaces the answer; the title is the line that follows.
test('skips a preamble line and takes the title under it', () => {
  expect(sanitizeTitle("Sure! Here's a title:\n\nSupply Base North Deep Dive")).toBe(
    'Supply Base North Deep Dive',
  )
})

// Some OpenAI-compatible servers inline the chain-of-thought in `content`
// rather than splitting it into `reasoning_content`. Taking the first line
// blindly would title the chat "<think>".
test('drops an inlined <think> block', () => {
  expect(sanitizeTitle('<think>\nThe user asks about Gauss law...\n</think>\n\nGauss Law Basics')).toBe(
    'Gauss Law Basics',
  )
})

test('returns null when there is no usable title', () => {
  expect(sanitizeTitle('')).toBeNull()
  expect(sanitizeTitle('   \n  ')).toBeNull()
  expect(sanitizeTitle('<think>only thinking, no answer</think>')).toBeNull()
})

test('caps an overlong title', () => {
  const long = 'Word '.repeat(40)
  expect((sanitizeTitle(long) as string).length).toBeLessThanOrEqual(60)
})
