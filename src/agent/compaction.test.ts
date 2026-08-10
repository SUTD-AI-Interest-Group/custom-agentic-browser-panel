import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { applyCompaction, estimateHistoryTokens, planCompaction } from './compaction'

const user = (text: string): ModelMessage => ({ role: 'user', content: text })
const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text })
const toolCall = (id: string, name: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName: name, input: {} }],
})
const toolResult = (id: string, name: string): ModelMessage => ({
  role: 'tool',
  content: [
    { type: 'tool-result', toolCallId: id, toolName: name, output: { type: 'json', value: {} } },
  ],
})

/**
 * Every tool-call id in the array must have its matching tool-result in the SAME
 * array, and vice versa. This is the invariant a naive slice breaks: a provider
 * 400s the whole request over one orphaned half, which would trade a
 * context-length error for a protocol error.
 */
function hasOrphanedToolCall(messages: ModelMessage[]): boolean {
  const called = new Set<string>()
  const resolved = new Set<string>()
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const p of m.content as Array<{ type: string; toolCallId?: string }>) {
      if (p.type === 'tool-call' && p.toolCallId) called.add(p.toolCallId)
      if (p.type === 'tool-result' && p.toolCallId) resolved.add(p.toolCallId)
    }
  }
  return (
    [...called].some((id) => !resolved.has(id)) || [...resolved].some((id) => !called.has(id))
  )
}

/** The native Anthropic adapter rejects consecutive user-role entries. */
function hasConsecutiveSameRole(messages: ModelMessage[]): boolean {
  return messages.some((m, i) => i > 0 && m.role === messages[i - 1].role && m.role !== 'tool')
}

/** Ten alternating turns: q0/a1 … q8/a9. */
function plainHistory(turns = 5): ModelMessage[] {
  return Array.from({ length: turns * 2 }, (_, i) =>
    i % 2 === 0 ? user(`q${i}`) : assistant(`a${i}`),
  )
}

describe('planCompaction', () => {
  it('returns null when there is nothing old enough to fold', () => {
    expect(planCompaction(plainHistory(2), { keepRecentUserTurns: 4 })).toBeNull()
  })

  it('returns null for an empty history', () => {
    expect(planCompaction([], { keepRecentUserTurns: 2 })).toBeNull()
  })

  it('never splits a tool call from its result', () => {
    const history = [
      user('q1'),
      toolCall('t1', 'ReadPage'),
      toolResult('t1', 'ReadPage'),
      assistant('a1'),
      user('q2'),
      toolCall('t2', 'ReadPage'),
      toolResult('t2', 'ReadPage'),
      assistant('a2'),
      user('q3'),
      assistant('a3'),
      user('q4'),
      assistant('a4'),
    ]
    const plan = planCompaction(history, { keepRecentUserTurns: 2 })
    expect(plan).not.toBeNull()
    expect(hasOrphanedToolCall(plan!.fold)).toBe(false)
    expect(hasOrphanedToolCall(plan!.keep)).toBe(false)
  })

  it('always cuts immediately before a user message', () => {
    // Deliberately IRREGULAR: turns of differing length, so a boundary that
    // drifted by a message or two would land on an assistant or tool entry
    // rather than coincidentally on another user message. A perfectly
    // alternating history cannot distinguish a correct cut from a shifted one
    // — mutation testing caught exactly that hole in the first version here.
    const history = [
      user('q1'),
      toolCall('t1', 'ReadPage'),
      toolResult('t1', 'ReadPage'),
      assistant('a1'),
      user('q2'),
      assistant('a2'),
      user('q3'),
      toolCall('t3', 'ReadTabs'),
      toolResult('t3', 'ReadTabs'),
      assistant('a3'),
      user('q4'),
      assistant('a4'),
    ]
    const plan = planCompaction(history, { keepRecentUserTurns: 2 })
    expect(plan!.keep[0].role).toBe('user')
    expect(plan!.keep[0]).toEqual(user('q3'))
  })

  it('keeps exactly the requested number of recent user turns', () => {
    const plan = planCompaction(plainHistory(6), { keepRecentUserTurns: 3 })
    expect(plan!.keep.filter((m) => m.role === 'user')).toHaveLength(3)
  })

  it('partitions the history without losing or duplicating a message', () => {
    const history = plainHistory(6)
    const plan = planCompaction(history, { keepRecentUserTurns: 2 })!
    expect([...plan.fold, ...plan.keep]).toEqual(history)
  })

  it('moves the boundary later rather than orphaning a tool result that opens the tail', () => {
    // The Nth-from-last user message sits BETWEEN a tool call and its result,
    // so the naive boundary would orphan the result into `keep`. The planner
    // must walk forward to the next safe user boundary instead.
    const history = [
      user('q1'),
      assistant('a1'),
      user('q2'),
      toolCall('t1', 'ReadPage'),
      toolResult('t1', 'ReadPage'),
      assistant('a2'),
      user('q3'),
      assistant('a3'),
    ]
    const plan = planCompaction(history, { keepRecentUserTurns: 2 })
    if (plan) {
      expect(hasOrphanedToolCall(plan.fold)).toBe(false)
      expect(hasOrphanedToolCall(plan.keep)).toBe(false)
    }
  })
})

describe('applyCompaction', () => {
  it('produces a history with no orphaned tool calls and no consecutive same-role turns', () => {
    const history = [
      user('q1'),
      toolCall('t1', 'ReadPage'),
      toolResult('t1', 'ReadPage'),
      assistant('a1'),
      user('q2'),
      assistant('a2'),
      user('q3'),
      assistant('a3'),
      user('q4'),
      assistant('a4'),
    ]
    const plan = planCompaction(history, { keepRecentUserTurns: 2 })!
    const next = applyCompaction(plan, 'Earlier: the user asked about X and we established Y.')
    expect(hasOrphanedToolCall(next)).toBe(false)
    expect(hasConsecutiveSameRole(next)).toBe(false)
  })

  it('opens with the summary as a user message followed by an assistant acknowledgement', () => {
    const plan = planCompaction(plainHistory(4), { keepRecentUserTurns: 2 })!
    const next = applyCompaction(plan, 'SUMMARY')
    expect(next[0].role).toBe('user')
    expect(JSON.stringify(next[0].content)).toContain('SUMMARY')
    expect(next[1].role).toBe('assistant')
  })

  it('leaves the kept tail byte-identical, so attachment sentinels survive', () => {
    // Compaction only ever drops WHOLE messages. If it rewrote the tail, a
    // `lychee-attachment:<id>` sentinel could be mangled and rehydrate broken.
    const plan = planCompaction(plainHistory(4), { keepRecentUserTurns: 2 })!
    expect(applyCompaction(plan, 'SUMMARY').slice(2)).toEqual(plan.keep)
  })

  it('is shorter than the history it replaces', () => {
    const history = plainHistory(6)
    const plan = planCompaction(history, { keepRecentUserTurns: 2 })!
    expect(applyCompaction(plan, 'SUMMARY').length).toBeLessThan(history.length)
  })
})

describe('estimateHistoryTokens', () => {
  it('grows with the size of the history', () => {
    expect(estimateHistoryTokens(plainHistory(6))).toBeGreaterThan(
      estimateHistoryTokens(plainHistory(2)),
    )
  })

  it('is zero for an empty history', () => {
    expect(estimateHistoryTokens([])).toBe(0)
  })

  it('counts structured tool content, not just plain strings', () => {
    // A tool result is often the biggest thing in a history (a page's text).
    // Estimating only string content would under-read it to nothing and never
    // trigger compaction on exactly the histories that need it most.
    const big = toolResult('t1', 'ReadPage')
    ;(big.content as Array<{ output: { type: string; value: unknown } }>)[0].output = {
      type: 'json',
      value: { text: 'x'.repeat(4000) },
    }
    expect(estimateHistoryTokens([big])).toBeGreaterThan(500)
  })
})
