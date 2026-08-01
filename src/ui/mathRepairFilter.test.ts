import { expect, test } from 'vitest'
import { hasUncompilableMath } from './mathRepairFilter'

// d12 F4 / d01 F3-adjacent (Chat.tsx half — see mathRepair.ts for the sibling
// splice-path fix, W2-E's finding, same underlying bug, independently fixed,
// no shared export needed): repairAssistantMath's filter called validateMath
// directly on raw, un-normalized text. validateMath's SCAN only recognizes
// $/$$, so it is structurally blind to \(...\)/\[...\] math — the exact style
// OpenAI-family models emit (mathDelimiters.ts's own header comment) — and the
// filter never even attempted a repair call for that entire class of model.

test('detects broken $-delimited math (the case that already worked)', () => {
  expect(hasUncompilableMath('The formula is $\\frac{a}{$ end.')).toBe(true)
})

test('detects broken \\(...\\) math after normalizing delimiters (the bug)', () => {
  expect(hasUncompilableMath('The formula is \\(\\frac{a}{\\) end.')).toBe(true)
})

test('detects broken \\[...\\] display math after normalizing delimiters', () => {
  expect(hasUncompilableMath('\\[\\frac{a}{\\]')).toBe(true)
})

test('does not flag ordinary prose with no math at all', () => {
  expect(hasUncompilableMath('Just a normal sentence with no math in it.')).toBe(false)
})

test('does not flag well-formed math in either delimiter style', () => {
  expect(hasUncompilableMath('$a + b = c$')).toBe(false)
  expect(hasUncompilableMath('\\(a + b = c\\)')).toBe(false)
})
