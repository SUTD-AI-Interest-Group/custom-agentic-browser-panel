import { test, expect } from 'vitest'
import { applyReasoningEffort } from './provider'

test('leaves the body untouched (same ref) when no effort is configured', () => {
  const body = { model: 'gpt-4o', messages: [] }
  expect(applyReasoningEffort(body, undefined)).toBe(body)
})

test("pins reasoning_effort so a reasoning model accepts function tools", () => {
  const body = { model: 'gpt-5.6-luna', messages: [], tools: [{}] }
  expect(applyReasoningEffort(body, 'none')).toEqual({
    model: 'gpt-5.6-luna',
    messages: [],
    tools: [{}],
    reasoning_effort: 'none',
  })
})

test('passes a graded effort through verbatim', () => {
  expect(applyReasoningEffort({ model: 'o3' }, 'low')).toEqual({
    model: 'o3',
    reasoning_effort: 'low',
  })
})

test('does not mutate the input body', () => {
  const body: Record<string, unknown> = { model: 'x' }
  applyReasoningEffort(body, 'high')
  expect(body).toEqual({ model: 'x' })
})
