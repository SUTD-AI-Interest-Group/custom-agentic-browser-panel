import { describe, expect, it } from 'vitest'
import type { UIMessage } from '../agent/agent'
import { conversationUsage, lastReportedInputTokens, usageLabel } from './usageDisplay'

const reply = (usage?: UIMessage['usage']): UIMessage => ({
  id: Math.random().toString(36).slice(2),
  role: 'assistant',
  parts: [{ type: 'text', text: 'hi' }],
  usage,
})

const ask = (): UIMessage => ({
  id: Math.random().toString(36).slice(2),
  role: 'user',
  parts: [{ type: 'text', text: 'hello' }],
})

describe('conversationUsage', () => {
  it('sums usage across assistant messages', () => {
    const total = conversationUsage([
      ask(),
      reply({ inputTokens: 100, outputTokens: 20 }),
      ask(),
      reply({ inputTokens: 250, outputTokens: 40 }),
    ])
    expect(total).toEqual({
      inputTokens: 350,
      outputTokens: 60,
      totalTokens: undefined,
      reasoningTokens: undefined,
      cachedInputTokens: undefined,
    })
  })

  it('ignores replies that reported no usage', () => {
    const total = conversationUsage([reply({ inputTokens: 100 }), reply(undefined)])
    expect(total?.inputTokens).toBe(100)
  })

  it('returns undefined when no message reported usage', () => {
    expect(conversationUsage([ask(), reply(undefined)])).toBeUndefined()
  })

  it('returns undefined for an empty transcript', () => {
    expect(conversationUsage([])).toBeUndefined()
  })
})

describe('lastReportedInputTokens', () => {
  it('reads the most recent reply that reported usage, not the first', () => {
    const found = lastReportedInputTokens([
      reply({ inputTokens: 100 }),
      reply({ inputTokens: 900 }),
    ])
    expect(found).toBe(900)
  })

  it('skips a trailing reply that reported nothing', () => {
    expect(lastReportedInputTokens([reply({ inputTokens: 500 }), reply(undefined)])).toBe(500)
  })

  it('is undefined when nothing in the transcript reported usage', () => {
    // The caller then falls back to a character estimate, which is the right
    // behaviour for an endpoint that reports no usage at all.
    expect(lastReportedInputTokens([ask(), reply(undefined)])).toBeUndefined()
  })

  it('is undefined for an empty transcript', () => {
    expect(lastReportedInputTokens([])).toBeUndefined()
  })
})

describe('usageLabel', () => {
  it('renders an in → out summary', () => {
    const label = usageLabel({ inputTokens: 1240, outputTokens: 340 }, {})
    expect(label.tokens).toBe('1.2k → 340')
  })

  it('adds a cost when rates are configured', () => {
    const label = usageLabel({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, {
      inputPerMTok: 3,
      outputPerMTok: 15,
    })
    expect(label.cost).toBe('$18.00')
  })

  it('omits the cost entirely when no rates are configured', () => {
    // Not '$0.00' — that would read as "this turn was free" rather than
    // "you haven't told me what this model costs".
    expect(usageLabel({ inputTokens: 100, outputTokens: 20 }, {}).cost).toBeUndefined()
  })

  it('names cached tokens in the detail only when the provider reported them', () => {
    const withCache = usageLabel({ inputTokens: 100, cachedInputTokens: 60, outputTokens: 20 }, {})
    expect(withCache.detail).toContain('60 cached')
    const without = usageLabel({ inputTokens: 100, outputTokens: 20 }, {})
    expect(without.detail).not.toContain('cached')
  })

  it('names reasoning tokens in the detail only when present', () => {
    const withReasoning = usageLabel({ outputTokens: 500, reasoningTokens: 400 }, {})
    expect(withReasoning.detail).toContain('400 reasoning')
    expect(usageLabel({ outputTokens: 500 }, {}).detail).not.toContain('reasoning')
  })

  it('treats a missing half as zero rather than omitting the arrow', () => {
    // A turn cut off before any output still reports its input cost.
    expect(usageLabel({ inputTokens: 800 }, {}).tokens).toBe('800 → 0')
  })
})
