// Pure guard for the chat auto-naming effect, extracted so it's unit-testable
// without mounting Chat.

export interface NamingGuardState {
  /** Bumped once per finished turn/cycle — the effect's own trigger. */
  turnSeq: number
  /** A naming attempt has already succeeded. */
  titled: boolean
  /** A previously-fired generateChatTitle call hasn't resolved yet. */
  inFlight: boolean
  /** Attempts fired so far. */
  tries: number
  maxTries: number
}

/**
 * Whether the naming effect should fire (another) generateChatTitle call this
 * render. Without `inFlight`, a slow namer (queued behind a busy local model)
 * racing a fast follow-up turn's own naming attempt could have two calls
 * outstanding at once — both deriving the title from the same earliest user
 * message, so the second is wasted work, and whichever resolves LAST wins
 * non-deterministically, silently overwriting an already-set title with a
 * stale, possibly worse one.
 */
export function shouldAttemptNaming(s: NamingGuardState): boolean {
  if (s.turnSeq === 0) return false
  if (s.titled) return false
  if (s.inFlight) return false
  if (s.tries >= s.maxTries) return false
  return true
}
