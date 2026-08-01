import type { ToolSet } from 'ai'
import { redactSecrets } from './redact'
import type { Trace } from './types'

/** Shown in place of a denied call's real arguments — see the module comment. */
const DENIED_INPUT_PLACEHOLDER = '[omitted — action was not approved]'

function isDenied(output: unknown): boolean {
  return !!(output && typeof output === 'object' && (output as { denied?: unknown }).denied)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** redactSecrets never throws by contract (redact.test.ts), but this call
 * site is the one place a broken redaction rule could otherwise leak an
 * unredacted secret into a span — fail closed instead. */
function safeRedact(v: unknown): unknown {
  try {
    return redactSecrets(v)
  } catch {
    return '[redaction failed]'
  }
}

/**
 * Wrap every tool's `execute` so each call becomes a Langfuse span on `trace`:
 * capturing the tool input, its output (or error), duration, and whether the
 * user's approval gate allowed it (`denied: true` results → `approved: false`).
 * Mutates the toolset in place and returns it. Only call this when a trace
 * exists (observability on) — there is no no-op fast path here by design.
 *
 * SECURITY (hardening audit d03 F5): tool arguments frequently carry a real
 * secret typed through the page — AutofillForm's `fields[].value`,
 * ControlPage's `text`/`value`, and the DOM registry's re-read `value`s that
 * flow back out through a tool's OWN result (`elements: registry`, see
 * domIndex.ts's IndexedElement). Two invariants hold here, both load-bearing:
 *
 *  1. Every input/output/error passed to `trace.span`/`span.end` goes through
 *     `redactSecrets` first — name-pattern AND value-shape redaction, so a
 *     card number or password is caught even when the argument's key name is
 *     as generic as "value" (see redact.ts's own module comment for why).
 *
 *  2. The span is only created AFTER `orig()` resolves — never before.
 *     `Trace.span()` synchronously enqueues its `input` for transmission the
 *     moment it's called (the Langfuse client batches eagerly on a timer/
 *     size trigger); creating it up front, before the wrapped tool's OWN
 *     requestApproval gate (inside orig()) has resolved, would queue the
 *     argument content even for a call the user goes on to DENY. Waiting
 *     costs only wall-clock precision, which `startTime` (captured before
 *     the call, not when the span is finally created) recovers.
 *
 *     When the call comes back denied, its input is dropped entirely rather
 *     than merely redacted-by-pattern: AutofillForm in particular never sets
 *     the top-level `denied` flag for a per-field decline (tools.ts just
 *     `continue`s past that field, so the call still returns `{filled,
 *     note}`) — so whenever a call-level denial IS reported, redaction is a
 *     best-effort heuristic layered on top, not the only thing standing
 *     between a secret and the span; a denied action has no debugging value
 *     that justifies betting on that heuristic being complete anyway.
 *
 * Every step above is independently wrapped so a redaction/serialization/
 * span-creation failure can never affect the tool's real return value or
 * rethrow a different error than the one the tool actually threw — see the
 * "never breaks a turn" tests in instrumentTools.test.ts.
 */
export function instrumentToolset(tools: ToolSet, trace: Trace): ToolSet {
  for (const [name, t] of Object.entries(tools)) {
    const orig = (t as { execute?: (...args: any[]) => unknown }).execute
    if (typeof orig !== 'function') continue
    ;(t as { execute?: (...args: any[]) => unknown }).execute = async (input: unknown, opts: unknown) => {
      const startTime = new Date().toISOString()
      let output: unknown
      try {
        output = await orig(input, opts)
      } catch (err) {
        try {
          const span = trace.span({ name: `tool:${name}`, input: safeRedact(input), startTime })
          span.end({ level: 'ERROR', statusMessage: safeRedact(errorMessage(err)) as string })
        } catch {
          /* instrumentation must never mask the tool's real error */
        }
        throw err
      }
      try {
        const denied = isDenied(output)
        const span = trace.span({
          name: `tool:${name}`,
          input: denied ? DENIED_INPUT_PLACEHOLDER : safeRedact(input),
          startTime,
        })
        span.end({ output: safeRedact(output), metadata: { approved: !denied } })
      } catch {
        /* instrumentation must never mask the tool's real result */
      }
      return output
    }
  }
  return tools
}
