import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { fallbackSummary, renderSpan, summarizeSpan } from './summarizeSpan'

const user = (text: string): ModelMessage => ({ role: 'user', content: text })
const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text })

describe('renderSpan', () => {
  it('labels each message by role', () => {
    expect(renderSpan([user('hello'), assistant('hi')])).toBe('User: hello\n\nAssistant: hi')
  })

  it('names a tool call without carrying its payload', () => {
    // The payload is what made the span too large in the first place.
    const span: ModelMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'ReadPage', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'ReadPage',
            output: { type: 'json', value: { text: 'x'.repeat(5000) } },
          },
        ],
      },
    ]
    const rendered = renderSpan(span)
    expect(rendered).toContain('[called ReadPage]')
    expect(rendered).toContain('[result from ReadPage]')
    expect(rendered).not.toContain('xxxxx')
  })

  it('trims from the front so the most recent turns survive the budget', () => {
    const span = Array.from({ length: 4000 }, (_, i) => user(`message number ${i}`))
    const rendered = renderSpan(span)
    expect(rendered).toContain('message number 3999')
    expect(rendered).not.toContain('message number 0\n')
  })

  it('drops a message with no renderable content rather than emitting a blank line', () => {
    const span: ModelMessage[] = [user('a'), { role: 'assistant', content: [] }, user('b')]
    expect(renderSpan(span)).toBe('User: a\n\nUser: b')
  })
})

describe('fallbackSummary', () => {
  it('returns the span verbatim when it is short enough', () => {
    expect(fallbackSummary([user('hello')])).toBe('User: hello')
  })

  it('states the gap rather than truncating silently', () => {
    // A silent truncation lets the model answer as though it still had the
    // whole history; a stated gap lets it admit what it lost.
    const span = Array.from({ length: 500 }, (_, i) => user(`a very long message number ${i}`))
    const summary = fallbackSummary(span)
    expect(summary).toContain('could not be summarized automatically')
    expect(summary).toContain('500 earlier messages')
  })
})

describe('summarizeSpan', () => {
  it('returns empty for an empty span without calling the model', async () => {
    // No model is passed at all — if it tried to call one, this would throw.
    expect(await summarizeSpan(undefined as never, [])).toBe('')
  })

  it('falls back instead of throwing when the model call fails', async () => {
    // Compaction runs precisely when a turn is already in trouble. It must
    // never become a new way for that turn to die.
    const broken = { modelId: 'broken' } as never
    const span = [user('what did we decide?'), assistant('we chose option B')]
    const summary = await summarizeSpan(broken, span)
    expect(typeof summary).toBe('string')
    expect(summary).toContain('option B')
  })
})
