import { expect, test } from 'vitest'
import { recentContext } from './recentContext'
import type { UIMessage } from '../agent/agent'

const user = (text: string): UIMessage => ({ id: 'u', role: 'user', parts: [{ type: 'text', text }] })
const asst = (text: string): UIMessage => ({ id: 'a', role: 'assistant', parts: [{ type: 'text', text }] })

test('renders alternating turns as Role: text lines, oldest first', () => {
  expect(recentContext([user('hello'), asst('hi there')])).toBe('User: hello\n\nAssistant: hi there')
})

test('returns an empty string for no messages', () => {
  expect(recentContext([])).toBe('')
})

test('skips a research report card — an artifact, not conversation', () => {
  const report: UIMessage = {
    id: 'r',
    role: 'assistant',
    parts: [{ type: 'text', text: 'a very long finished report' }],
    research: { question: 'q' },
  }
  expect(recentContext([user('hi'), report])).toBe('User: hi')
})

test('skips a launch-card proposal message', () => {
  const proposal: UIMessage = {
    id: 'p',
    role: 'assistant',
    parts: [],
    proposal: { taskId: 't', question: 'q', subQuestions: [], sites: [], draftedAt: 0 },
  }
  expect(recentContext([user('hi'), proposal])).toBe('User: hi')
})

test('a message with no text part contributes nothing, not a blank line', () => {
  const toolOnly: UIMessage = {
    id: 't',
    role: 'assistant',
    parts: [{ type: 'tool', toolCallId: '1', toolName: 'ReadPage', input: {}, state: 'done' }],
  }
  expect(recentContext([user('hi'), toolOnly, user('bye')])).toBe('User: hi\n\nUser: bye')
})

test('keeps only the most recent messages', () => {
  const messages = Array.from({ length: 20 }, (_, i) => user(`msg${i}`))
  const out = recentContext(messages)
  expect(out).not.toContain('msg0')
  expect(out).not.toContain('msg11')
  expect(out).toContain('msg19')
})

test('truncates from the front, keeping the most recent characters', () => {
  // The b-message alone (4500 chars) exceeds the 4000-char cap, so slicing
  // the last 4000 characters lands entirely inside it — nothing of the
  // a-message (or even the "User: " prefixes) should survive.
  const messages = [user('a'.repeat(2000)), user('b'.repeat(4500))]
  const out = recentContext(messages)
  expect(out.length).toBe(4000)
  expect(out).not.toContain('a')
  expect(out).not.toContain('User:')
  expect(out).toBe('b'.repeat(4000))
})
