import { test, expect } from 'vitest'
import { buildRetryNote, MAX_PROBLEMS, MAX_PROBLEM_CHARS } from './regenerate'
import type { UIMessage } from '../agent/agent'

function reply(parts: UIMessage['parts']): UIMessage {
  return { id: 'a1', role: 'assistant', parts }
}

function toolPart(over: Partial<Extract<UIMessage['parts'][number], { type: 'tool' }>> = {}) {
  return {
    type: 'tool' as const,
    toolCallId: 'c1',
    toolName: 'GroupTabs',
    input: {},
    state: 'done' as const,
    ...over,
  }
}

test('a clean attempt gets the nudge alone — no problems section', () => {
  const note = buildRetryNote([reply([{ type: 'text', text: 'Here is your answer.' }])])
  expect(note).toContain('discarded your previous response')
  expect(note).not.toContain('problems')
})

test('the chain-level **Error:** line is lifted out of the discarded bubble', () => {
  const note = buildRetryNote([
    reply([
      { type: 'text', text: 'Partial work…' },
      { type: 'text', text: '**Error:** 429 rate_limit_exceeded' },
    ]),
  ])
  expect(note).toContain('- Error: 429 rate_limit_exceeded')
  // Ordinary prose is not mistaken for a failure.
  expect(note).not.toContain('Partial work')
})

test("a tool part in the 'error' state reports its errorText", () => {
  const note = buildRetryNote([
    reply([toolPart({ state: 'error', errorText: 'tabGroups permission denied' })]),
  ])
  expect(note).toContain('- GroupTabs failed: tabGroups permission denied')
})

test('a successful-looking call whose output carries an error string still counts', () => {
  const note = buildRetryNote([
    reply([toolPart({ toolName: 'ReadPage', output: { error: 'the tab was discarded' } })]),
  ])
  expect(note).toContain('- ReadPage failed: the tab was discarded')
})

test('a denied call is reported as a denial, not as a failure', () => {
  const note = buildRetryNote([
    reply([toolPart({ toolName: 'CloseTabs', output: { denied: true, message: 'nope' } })]),
  ])
  expect(note).toContain('- CloseTabs: the user denied permission for this call')
  expect(note).not.toContain('CloseTabs failed')
})

test('an errored tool with no detail still names the tool', () => {
  const note = buildRetryNote([reply([toolPart({ toolName: 'ReadTabs', state: 'error' })])])
  expect(note).toContain('- ReadTabs failed (no detail reported)')
})

test('identical problems across bubbles collapse to one line', () => {
  const parts = [toolPart({ state: 'error', errorText: 'boom' })]
  const note = buildRetryNote([reply(parts), reply(parts)])
  expect(note.match(/- GroupTabs failed: boom/g)).toHaveLength(1)
})

test('the problem list is capped so a tool-heavy failure cannot swamp the prompt', () => {
  const parts = Array.from({ length: MAX_PROBLEMS + 5 }, (_, i) => ({
    ...toolPart({ state: 'error', errorText: `failure ${i}` }),
    toolCallId: `c${i}`,
  }))
  const note = buildRetryNote([reply(parts)])
  expect(note.match(/^- /gm)).toHaveLength(MAX_PROBLEMS)
  expect(note).toContain(`and 5 more`)
})

test('a single runaway error message is truncated', () => {
  const note = buildRetryNote([
    reply([toolPart({ state: 'error', errorText: 'x'.repeat(MAX_PROBLEM_CHARS + 500) })]),
  ])
  const line = (note.match(/^- .*$/m) as string[])[0]
  expect(line.length).toBeLessThanOrEqual(MAX_PROBLEM_CHARS + 40)
  expect(line.endsWith('…')).toBe(true)
})

test('user bubbles in the discarded slice (steers) contribute nothing', () => {
  const note = buildRetryNote([
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: '**Error:** not really' }] },
  ])
  expect(note).not.toContain('not really')
})

test('reasoning that merely talks about an error is not scraped', () => {
  const note = buildRetryNote([
    reply([{ type: 'reasoning', text: '**Error:** I should double-check this' }]),
  ])
  expect(note).not.toContain('double-check')
})
