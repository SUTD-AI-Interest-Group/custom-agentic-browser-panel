import { describe, expect, it } from 'vitest'
import type { RunOutcome } from './engine'
import {
  budgetOutcome,
  escapeHtml,
  isExecHostMsg,
  isExecSandboxMsg,
  LOG_LINE_MAX,
  LOGS_MAX,
  VALUE_MAX,
} from './protocol'

function outcome(partial: Partial<RunOutcome>): RunOutcome {
  return { ok: true, logs: [], timedOut: false, durationMs: 1, ...partial }
}

describe('message guards', () => {
  it('accepts host messages', () => {
    expect(isExecHostMsg({ type: 'exec:init', requestId: 'r', wasm: new ArrayBuffer(4) })).toBe(true)
    expect(isExecHostMsg({ type: 'exec:run', requestId: 'r', code: '1', timeoutMs: 5, memoryBytes: 6 })).toBe(true)
    expect(isExecHostMsg({ type: 'exec:render', requestId: 'r', html: '<p>' })).toBe(true)
  })

  it('rejects malformed host messages', () => {
    expect(isExecHostMsg(null)).toBe(false)
    expect(isExecHostMsg({})).toBe(false)
    expect(isExecHostMsg({ type: 'exec:run', requestId: 'r' })).toBe(false)
    expect(isExecHostMsg({ type: 'exec:init', requestId: 'r', wasm: 'not bytes' })).toBe(false)
    expect(isExecHostMsg({ type: 'exec:ready' })).toBe(false)
  })

  it('accepts sandbox messages', () => {
    expect(isExecSandboxMsg({ type: 'exec:ready' })).toBe(true)
    expect(isExecSandboxMsg({ type: 'exec:done', requestId: 'r', ok: true })).toBe(true)
    expect(isExecSandboxMsg({ type: 'exec:done', requestId: 'r', ok: false, error: 'x' })).toBe(true)
  })

  it('rejects malformed sandbox messages', () => {
    expect(isExecSandboxMsg(undefined)).toBe(false)
    expect(isExecSandboxMsg({ type: 'exec:done', ok: true })).toBe(false)
    expect(isExecSandboxMsg({ type: 'exec:run', requestId: 'r', code: '1', timeoutMs: 5, memoryBytes: 6 })).toBe(false)
  })
})

describe('budgetOutcome', () => {
  it('passes small outcomes through untouched', () => {
    const o = outcome({ value: '42', logs: ['hi'] })
    const { outcome: budgeted, valueOverflow } = budgetOutcome(o)
    expect(budgeted).toEqual(o)
    expect(valueOverflow).toBeNull()
  })

  it('truncates long log lines and caps the line count with a marker', () => {
    const o = outcome({ logs: Array.from({ length: LOGS_MAX + 10 }, (_, i) => `line ${i} ${'x'.repeat(LOG_LINE_MAX)}`) })
    const { outcome: budgeted } = budgetOutcome(o)
    expect(budgeted.logs.length).toBe(LOGS_MAX + 1)
    expect(budgeted.logs[0].length).toBeLessThanOrEqual(LOG_LINE_MAX + 1)
    expect(budgeted.logs[LOGS_MAX]).toContain('more line')
  })

  // F4 (d10): the engine's own MAX_LOG_LINES cap can silently discard far
  // more lines than this panel-side trim ever sees — the "+N more" note must
  // count both, or heavy logging understates how much output actually existed.
  it('folds the engine-level dropped-line count into the "+N more" note', () => {
    const o = outcome({
      logs: Array.from({ length: LOGS_MAX + 5 }, (_, i) => `line ${i}`),
      logsDropped: 50,
    })
    const { outcome: budgeted } = budgetOutcome(o)
    expect(budgeted.logs.length).toBe(LOGS_MAX + 1)
    // 5 trimmed here by this function, plus 50 the engine already dropped.
    expect(budgeted.logs[LOGS_MAX]).toContain('+55 more')
  })

  it('does not require logsDropped to be set (older/synthetic outcomes)', () => {
    const o = outcome({ logs: ['a', 'b'] })
    const { outcome: budgeted } = budgetOutcome(o)
    expect(budgeted.logs).toEqual(['a', 'b'])
  })

  it('budgets an error (ok: false) outcome the same way as a successful one', () => {
    const o = outcome({
      ok: false,
      error: 'boom',
      logs: Array.from({ length: LOGS_MAX + 3 }, (_, i) => `line ${i}`),
    })
    const { outcome: budgeted } = budgetOutcome(o)
    expect(budgeted.ok).toBe(false)
    expect(budgeted.error).toBe('boom')
    expect(budgeted.logs.length).toBe(LOGS_MAX + 1)
  })

  it('trims logs and the value in the same outcome', () => {
    const big = 'v'.repeat(VALUE_MAX + 50)
    const o = outcome({
      value: big,
      logs: Array.from({ length: LOGS_MAX + 5 }, (_, i) => `line ${i}`),
    })
    const { outcome: budgeted, valueOverflow } = budgetOutcome(o)
    expect(budgeted.logs.length).toBe(LOGS_MAX + 1)
    expect(budgeted.value?.length).toBeLessThan(big.length)
    expect(valueOverflow).toBe(big)
  })

  it('truncates an oversized value and returns the original as overflow', () => {
    const big = 'v'.repeat(VALUE_MAX + 100)
    const { outcome: budgeted, valueOverflow } = budgetOutcome(outcome({ value: big }))
    expect(budgeted.value?.length).toBeLessThan(big.length)
    expect(budgeted.value).toContain('truncated')
    expect(valueOverflow).toBe(big)
  })
})

describe('escapeHtml', () => {
  it('escapes markup-significant characters', () => {
    expect(escapeHtml('<a b="c">&')).toBe('&lt;a b=&quot;c&quot;&gt;&amp;')
  })
})
