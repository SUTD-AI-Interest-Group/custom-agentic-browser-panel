import type { UIPart } from '../agent/agent'
import { useEffect, useState } from 'react'
import { getTrace, type StoredTrace, type TraceStep } from '../data/traces'
import { formatTokens } from '../agent/pricing'

// The local trace of one turn, as a collapsible drawer above its reply.
//
// Renders the things the transcript structurally cannot show: which tools were
// actually available at each step (progressive disclosure is invisible from the
// outside), when repairToolCall rewrote a call, and when queued images were
// drained into the prompt. Loads lazily on expand — most replies are never
// inspected, and reading every trace on render would cost a store hit per bubble.

function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`
}

function StepRow({ step }: { step: TraceStep }) {
  // Guard on the type, not just presence: a record written by an older build
  // could hold a non-numeric value here, and formatTokens would render `NaN`
  // rather than simply omitting a figure it does not have.
  const inTok = typeof step.usage?.inputTokens === 'number' ? step.usage.inputTokens : undefined
  const outTok = typeof step.usage?.outputTokens === 'number' ? step.usage.outputTokens : undefined
  const tokens = inTok !== undefined || outTok !== undefined
  return (
    <li className="trace-step">
      <div className="trace-step-head">
        <span className="trace-step-index">{step.index + 1}</span>
        <span className="trace-step-calls">
          {step.toolCalls.length === 0
            ? 'answered'
            : step.toolCalls.map((c) => `${c.name}${c.ok ? '' : ' ✗'}`).join(', ')}
        </span>
        <span className="trace-step-time">{ms(step.durationMs)}</span>
      </div>
      <div className="trace-step-meta">
        {/* The whole point of the drawer: what the model could see this step. */}
        <span title={step.activeTools.join(', ')}>
          {step.activeTools.length} tool{step.activeTools.length === 1 ? '' : 's'} available
        </span>
        {tokens ? (
          <span>
            {formatTokens(inTok ?? 0)} → {formatTokens(outTok ?? 0)}
          </span>
        ) : null}
        {step.imagesDrained ? <span>{step.imagesDrained} image(s) shown</span> : null}
        {step.finishReason ? <span>{step.finishReason}</span> : null}
      </div>
      {step.repaired && (
        // Without this line, a repaired call reads as the model spontaneously
        // calling GetTool — the single most confusing thing in a trace.
        <div className="trace-step-repair">
          rewrote <code>{step.repaired.from}</code> → <code>{step.repaired.to}</code> (tool not
          loaded yet)
        </div>
      )}
    </li>
  )
}

export default function TraceDrawer({ turnId, parts, recorded, streaming }: {
  turnId: string
  parts: UIPart[]
  recorded: boolean
  streaming: boolean
}) {
  const calls = parts.filter((part): part is Extract<UIPart, { type: 'tool' }> => part.type === 'tool')
  const running = calls.find(call => call.state === 'running')
  const [open, setOpen] = useState(false)
  const [trace, setTrace] = useState<StoredTrace | null | undefined>(undefined)

  useEffect(() => {
    if (!open || !recorded || streaming) return
    let cancelled = false
    void getTrace(turnId)
      .then((t) => {
        if (!cancelled) setTrace(t ?? null)
      })
      .catch(() => {
        if (!cancelled) setTrace(null)
      })
    return () => {
      cancelled = true
    }
  }, [open, turnId, recorded, streaming])

  return (
    <div className={`trace-drawer ${open ? 'open' : ''}`}>
      <button className="trace-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg className="reasoning-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>Trace</span>
        {calls.length > 0 && <span className="trace-call-count">{running ? `${running.toolName}…` : `${calls.length} call${calls.length === 1 ? '' : 's'}`}</span>}
      </button>
      {open && (
        <div className="trace-body">
          {recorded && !streaming && trace === undefined && <div className="trace-empty">Loading…</div>}
          {recorded && trace === null && calls.length === 0 && <div className="trace-empty">No trace recorded for this turn.</div>}
          {calls.length > 0 && (
            <ol className="trace-steps trace-calls">
              {calls.map(call => {
                const output = call.output as { denied?: boolean; error?: unknown } | undefined
                const error = call.errorText ?? (typeof output?.error === 'string' ? output.error : undefined)
                const status = call.state === 'running' ? 'In progress' : output?.denied ? 'Denied' : call.state === 'error' || error ? 'Failed' : 'Done'
                return (
                  <li key={call.toolCallId}>
                    <details className="trace-call">
                      <summary><span>{call.toolName}</span><span className="trace-call-status">{status}</span></summary>
                      {error && <div className="tool-error-text">{error}</div>}
                      <pre>{JSON.stringify({ input: call.input, output: call.output }, null, 2)}</pre>
                    </details>
                  </li>
                )
              })}
            </ol>
          )}
          {trace && (
            <>
              <div className="trace-summary">
                {trace.steps.length} step{trace.steps.length === 1 ? '' : 's'}
              </div>
              <ol className="trace-steps">
                {trace.steps.map((s) => (
                  <StepRow key={s.index} step={s} />
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </div>
  )
}
