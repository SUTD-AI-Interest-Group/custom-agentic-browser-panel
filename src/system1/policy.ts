// The boundary between the browser harness and any decision model: a policy
// is given the goal, the observation and the FINITE candidate space, and
// returns one decision naming an operation, a target id and a value key from
// that space. Von (vonPolicy.ts), an LLM (the eval's llmPolicy) and any future
// model implement this and are compared on identical inputs. The boundary
// never trusts an adapter: validate.ts checks membership before anything runs.
import type { BrowserObservation } from './observation'
import type { BrowserOperation, CandidateActionSpace } from './candidates'

export const BLOCKED_REASONS = ['AUTH_REQUIRED', 'CAPTCHA', 'MISSING_USER_DATA', 'UNSUPPORTED_UI', 'NO_VALID_ACTION'] as const
export type BlockedReason = (typeof BLOCKED_REASONS)[number]

/** A past step as the policy sees it (actLoop's ActStep satisfies this). The value is its KEY, never its text. */
export interface StepLike {
  operation: BrowserOperation
  targetId?: number
  label?: string
  valueKey?: string
  result: 'success' | 'no_change' | 'stale'
}

export interface DecisionContext {
  goal: string
  observation: BrowserObservation
  space: CandidateActionSpace
  /** The supplied values. An adapter may render a value's text ONLY inside the value question's options, clipped. */
  values: Record<string, string>
  steps: readonly StepLike[]
  /**
   * The loop's confidence gate. An adapter may stop asking further heads once
   * one falls below it (the loop will return `uncertain` anyway), so a
   * low-confidence operation does not also pay for a target pass.
   */
  threshold?: number
}

export interface BrowserDecision {
  operation: BrowserOperation
  targetId?: number
  valueKey?: string
  blockedReason?: BlockedReason
  /** Calibrated top probability per head actually asked. */
  confidence: { operation: number; target?: number; value?: number; blockedReason?: number }
  /** The target head's top candidates (final round), for an `uncertain` hand-back. */
  ranked?: { id: number; p: number }[]
  ms: number
}

export interface BrowserPolicy {
  decide(ctx: DecisionContext): Promise<BrowserDecision>
}

/** The context cannot be rendered within the model's input budget even after shrinking what is shown. */
export class PolicyInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyInputError'
  }
}
