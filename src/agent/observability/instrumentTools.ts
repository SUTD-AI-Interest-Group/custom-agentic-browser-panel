import type { ToolSet } from 'ai'
import type { Trace } from './types'

/**
 * Wrap every tool's `execute` so each call becomes a Langfuse span on `trace`:
 * capturing the tool input, its output (or error), duration, and whether the
 * user's approval gate allowed it (`denied: true` results → `approved: false`).
 * Mutates the toolset in place and returns it. Only call this when a trace
 * exists (observability on) — there is no no-op fast path here by design.
 */
export function instrumentToolset(tools: ToolSet, trace: Trace): ToolSet {
  for (const [name, t] of Object.entries(tools)) {
    const orig = (t as { execute?: (...args: any[]) => unknown }).execute
    if (typeof orig !== 'function') continue
    ;(t as { execute?: (...args: any[]) => unknown }).execute = async (input: unknown, opts: unknown) => {
      const span = trace.span({ name: `tool:${name}`, input })
      try {
        const output = await orig(input, opts)
        const denied = !!(output && typeof output === 'object' && (output as { denied?: unknown }).denied)
        span.end({ output, metadata: { approved: !denied } })
        return output
      } catch (err) {
        span.end({ level: 'ERROR', statusMessage: err instanceof Error ? err.message : String(err) })
        throw err
      }
    }
  }
  return tools
}
