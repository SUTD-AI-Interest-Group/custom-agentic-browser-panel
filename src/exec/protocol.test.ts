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
