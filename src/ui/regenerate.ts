// The note a regenerated turn carries about the attempt it replaced.
//
// Regenerate throws away the assistant bubbles of the last turn and re-runs it.
// Everything those bubbles knew about what went wrong — the chain-level error,
// the tool calls that failed, the permission the user refused — would go with
// them, and the retry would walk into the same wall. So the bubbles are scraped
// for failures on the way out and the result is appended to the retry's *system*
// prompt (see runTurnChain): system rather than history, so it stays scoped to
// the one chain and never becomes a dangling user turn the native Anthropic
// adapter would reject.
//
// Pure over UIMessage[] — no Chrome, no React, no AI SDK.

import type { UIMessage } from '../agent/agent'

/** Problems listed before the rest are summarized as a count. */
export const MAX_PROBLEMS = 10
/** Longest single problem detail kept, so one runaway stack trace can't swamp
 *  the system prompt it rides in. */
export const MAX_PROBLEM_CHARS = 300

/** The prefix runTurnChain's catch stamps on a failed chain's closing text part. */
const CHAIN_ERROR_RE = /^\*\*Error:\*\*\s*/

function clip(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.length > MAX_PROBLEM_CHARS ? `${trimmed.slice(0, MAX_PROBLEM_CHARS)}…` : trimmed
}

/**
 * Every failure recorded in `discarded`, in transcript order and deduped: the
 * chain-level error text, tool calls that errored, tool results that reported an
 * error of their own, and calls the user denied. Only assistant bubbles are read
 * — a steer bubble is the user's own words, and reasoning is the model narrating
 * to itself, neither of which is evidence that anything failed.
 */
export function collectProblems(discarded: UIMessage[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const add = (line: string) => {
    if (seen.has(line)) return
    seen.add(line)
    problems.push(line)
  }

  for (const message of discarded) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts) {
      if (part.type === 'text') {
        if (CHAIN_ERROR_RE.test(part.text)) add(`Error: ${clip(part.text.replace(CHAIN_ERROR_RE, ''))}`)
        continue
      }
      if (part.type !== 'tool') continue
      const output = part.output as { error?: unknown; denied?: unknown } | undefined
      if (output?.denied) {
        add(`${part.toolName}: the user denied permission for this call`)
      } else if (part.state === 'error') {
        add(
          part.errorText
            ? `${part.toolName} failed: ${clip(part.errorText)}`
            : `${part.toolName} failed (no detail reported)`,
        )
      } else if (typeof output?.error === 'string') {
        add(`${part.toolName} failed: ${clip(output.error)}`)
      }
    }
  }
  return problems
}

/**
 * The system-prompt note for a regenerated turn: always the instruction that the
 * user rejected the previous response (so the retry varies rather than restating
 * it), plus the failures to steer around when the discarded attempt had any.
 */
export function buildRetryNote(discarded: UIMessage[]): string {
  const problems = collectProblems(discarded)
  const note = [
    '\n\n## Previous attempt',
    'The user discarded your previous response and asked you to try again. Take a different approach rather than restating it.',
  ]
  if (problems.length > 0) {
    const shown = problems.slice(0, MAX_PROBLEMS)
    const rest = problems.length - shown.length
    note.push(
      '',
      'That attempt ran into the problems below. Correct for them — do not repeat them, and if one is unrecoverable, say so plainly instead of retrying it blindly:',
      ...shown.map((p) => `- ${p}`),
      ...(rest > 0 ? [`…and ${rest} more.`] : []),
    )
  }
  return note.join('\n')
}
