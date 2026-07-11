import { test, expect } from 'vitest'
import { parseJsonLoose } from './webFetch'

test('parses fenced json', () => {
  expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 })
})
test('parses json with surrounding prose', () => {
  expect(parseJsonLoose('Sure! {"a":2} done')).toEqual({ a: 2 })
})
test('parses top-level array', () => {
  expect(parseJsonLoose('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }])
})
test('throws on non-json', () => {
  expect(() => parseJsonLoose('nope')).toThrow()
})
