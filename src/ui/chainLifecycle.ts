// Pure decisions around a continuation chain's (runTurnChain, Chat.tsx) start
// and end, extracted so they're unit-testable without mounting Chat — which has
// no React-Testing-Library-style harness today.

/**
 * Why a continuation chain's `while` loop stopped. Mirrors runAgentTurn's
 * TurnStopReason plus the two outcomes only the chain itself can produce
 * (a caught abort vs. a caught error).
 */
export type ChainExitReason = 'parked' | 'completed' | 'checkpoint' | 'budget' | 'error' | 'aborted'

/**
 * Whether ending a chain for this reason should tear down the page-control
 * session and its on-page presence overlay (tint/cursor/spotlight).
 *
 * Only 'parked' must not: tools.ts's ControlPage deliberately lets the session
 * survive a park (the user granted it and hasn't revoked it — see its own
 * comment), so returning to the tab resumes mid-plan instead of asking for
 * control a second time. Every other exit — the chain actually finished,
 * checkpointed to the Continue card, hit the step budget, errored, or was
 * aborted — has no "come back and resume" story, so the session and overlay
 * must go, or a later, unrelated turn would inherit stale control.
 */
export function shouldTearDownPageControl(reason: ChainExitReason): boolean {
  return reason !== 'parked'
}
