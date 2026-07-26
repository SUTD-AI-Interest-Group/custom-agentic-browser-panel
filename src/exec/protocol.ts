// The panel ↔ sandbox-exec.html message protocol, plus the output budgets the
// RunCode tool applies before a result enters model history. Pure — no Chrome,
// no DOM, no engine imports beyond the RunOutcome type — so it is unit-testable
// and shared verbatim by both sides of the postMessage boundary (the same
// defensive-guard style as src/mcp/appBridge.ts).

import type { RunOutcome } from './engine'

/** Panel → sandbox: instantiate the engine from transferred wasm bytes. */
export interface ExecInitMsg {
  type: 'exec:init'
  requestId: string
  wasm: ArrayBuffer
}

/** Panel → sandbox: run one script under the given limits. */
export interface ExecRunMsg {
  type: 'exec:run'
  requestId: string
  code: string
  timeoutMs: number
  memoryBytes: number
}

/** Panel → sandbox: mount artifact HTML in the nested scripts-only iframe. */
export interface ExecRenderMsg {
  type: 'exec:render'
  requestId: string
  html: string
}

export type ExecHostMsg = ExecInitMsg | ExecRunMsg | ExecRenderMsg

/** Sandbox → panel: the page's script is loaded and listening. */
export interface ExecReadyMsg {
  type: 'exec:ready'
}

/** Sandbox → panel: one request finished (ok=false is a sandbox-level failure). */
export interface ExecDoneMsg {
  type: 'exec:done'
  requestId: string
  ok: boolean
  error?: string
  outcome?: RunOutcome
}

export type ExecSandboxMsg = ExecReadyMsg | ExecDoneMsg

function isRecord(d: unknown): d is Record<string, unknown> {
  return typeof d === 'object' && d !== null
}

/** True for a well-formed panel→sandbox message. */
export function isExecHostMsg(d: unknown): d is ExecHostMsg {
  if (!isRecord(d) || typeof d.requestId !== 'string') return false
  switch (d.type) {
    case 'exec:init':
      return d.wasm instanceof ArrayBuffer
    case 'exec:run':
      return typeof d.code === 'string' && typeof d.timeoutMs === 'number' && typeof d.memoryBytes === 'number'
    case 'exec:render':
      return typeof d.html === 'string'
    default:
      return false
  }
}

/** True for a well-formed sandbox→panel message. */
export function isExecSandboxMsg(d: unknown): d is ExecSandboxMsg {
  if (!isRecord(d)) return false
  if (d.type === 'exec:ready') return true
  if (d.type === 'exec:done') return typeof d.requestId === 'string' && typeof d.ok === 'boolean'
  return false
}

// Budgets: a tool result re-enters model history and is re-sent every step,
// so RunCode output is clamped hard; the full value spills to an artifact.
export const LOGS_MAX = 40
export const LOG_LINE_MAX = 400
export const VALUE_MAX = 8000
export const RUN_TIMEOUT_MS = 5000
export const RUN_MEMORY_BYTES = 64 * 1024 * 1024

/**
 * Clamp an outcome to the model-history budgets. When the completion value
 * overflowed, the untruncated original comes back in `valueOverflow` so the
 * caller can spill it somewhere user-facing instead of losing it.
 */
export function budgetOutcome(o: RunOutcome): { outcome: RunOutcome; valueOverflow: string | null } {
  let logs = o.logs.map((l) => (l.length > LOG_LINE_MAX ? `${l.slice(0, LOG_LINE_MAX)}…` : l))
  if (logs.length > LOGS_MAX) {
    const dropped = logs.length - LOGS_MAX
    logs = [...logs.slice(0, LOGS_MAX), `… [+${dropped} more line${dropped === 1 ? '' : 's'}]`]
  }
  let value = o.value
  let valueOverflow: string | null = null
  if (value !== undefined && value.length > VALUE_MAX) {
    valueOverflow = value
    value = `${value.slice(0, VALUE_MAX)}… [truncated ${value.length - VALUE_MAX} chars]`
  }
  return { outcome: { ...o, logs, value }, valueOverflow }
}

/** Minimal HTML escaping for wrapping plain text in a document. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
