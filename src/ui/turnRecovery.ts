// Deciding whether an interrupted turn may be offered back to the user, and
// rebuilding the pieces `runTurnChain` needs to pick it up.
//
// Pure and Chrome/React-free, matching this directory's file-per-pure-helper
// convention (chatNaming.ts, recentContext.ts, usageDisplay.ts, …) so the one
// rule that actually matters here — that a resumed turn never inherits a
// page-control grant — is locked down by a unit test rather than by a comment.

import { clearInFlight, saveInFlight, type InFlightTurn } from '../data/conversations'

/**
 * Debounce window for checkpoint writes. Long enough that a fast stream
 * coalesces into a handful of writes rather than hundreds, short enough that a
 * panel closed mid-reply loses at most about a second of it.
 */
const CHECKPOINT_DEBOUNCE_MS = 1000

// One pending timer and payload per conversation. Module-level (not a ref) for
// the same reason drafts.ts does it: a fresh Chat mount on conversation switch
// must not cancel a still-pending write belonging to the chat just left.
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingRecords = new Map<string, InFlightTurn>()

/**
 * Checkpoint a streaming turn, coalescing rapid calls into one write per pause.
 *
 * Deliberately fire-and-forget: this insures the turn, so it must never be able
 * to stall or fail it. A rejected write leaves the previous checkpoint in place,
 * which is strictly better than no checkpoint and strictly better than a broken
 * turn.
 */
export function scheduleInFlightSave(record: InFlightTurn): void {
  const key = record.conversationId
  pendingRecords.set(key, record)
  const pending = timers.get(key)
  if (pending) clearTimeout(pending)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      const latest = pendingRecords.get(key)
      pendingRecords.delete(key)
      if (latest) void saveInFlight(latest).catch(() => {})
    }, CHECKPOINT_DEBOUNCE_MS),
  )
}

/**
 * Write any pending checkpoint immediately. Called from `pagehide`, where the
 * debounce timer will never fire because the document is going away.
 *
 * Best-effort by nature: the panel may be torn down before an async IndexedDB
 * write commits. The debounce above is the real mechanism — this only narrows
 * the window it leaves open.
 */
export function flushInFlightSave(conversationId: string): void {
  const pending = timers.get(conversationId)
  if (pending) {
    clearTimeout(pending)
    timers.delete(conversationId)
  }
  const latest = pendingRecords.get(conversationId)
  pendingRecords.delete(conversationId)
  if (latest) void saveInFlight(latest).catch(() => {})
}

/**
 * Drop a checkpoint and cancel any pending debounced write, so a queued save
 * cannot resurrect a turn the user just discarded — the same hazard
 * `clearDraft` guards against.
 */
export async function discardInFlight(conversationId: string): Promise<void> {
  const pending = timers.get(conversationId)
  if (pending) {
    clearTimeout(pending)
    timers.delete(conversationId)
  }
  pendingRecords.delete(conversationId)
  await clearInFlight(conversationId)
}

/**
 * How long an interrupted turn stays offerable. A week is generous for "I
 * closed the panel and came back", and short enough that a checkpoint from a
 * crash last month is swept rather than resurrected into a conversation whose
 * page, tabs and intent have all moved on.
 */
export const INFLIGHT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Tolerance for a checkpoint stamped slightly in the future. Machines sleep and
 * clocks step; a few minutes of skew is ordinary and must not throw away a
 * checkpoint written seconds ago. The same reasoning (and roughly the same
 * window) as dream.ts's clock-skew allowance on its lock.
 */
const FUTURE_SKEW_TOLERANCE_MS = 5 * 60 * 1000

/**
 * May this checkpoint be offered as "Resume"?
 *
 * Rejects three cases, each because resuming would be worse than not offering:
 * a checkpoint too old to still be what the user meant, one stamped
 * implausibly in the future (clock skew beyond tolerance, or a corrupted
 * write — either way not trustworthy), and one with no history at all, which
 * would post an empty prompt and bill the user for a turn that cannot speak.
 */
export function isResumable(record: InFlightTurn, now: number): boolean {
  if (!record.history || record.history.length === 0) return false
  const age = now - record.updatedAt
  if (age > INFLIGHT_MAX_AGE_MS) return false
  if (age < -FUTURE_SKEW_TOLERANCE_MS) return false
  return true
}

/**
 * Rebuild what `runTurnChain` needs from a checkpoint.
 *
 * The return shape is deliberately exactly `{ ctx, activeNames }` — and a test
 * asserts that key set exactly. **A resumed turn must never inherit a
 * page-control grant.** The stored session was fenced to a tab and origin that
 * have very likely changed since; carrying it forward would let a turn resume
 * with permission to act on a page the user never approved. Re-requesting
 * control costs one card and is the only safe answer.
 *
 * `activeNames` is copied into a fresh Set rather than aliased, so a resumed
 * chain loading more tools cannot mutate the record it was restored from — the
 * record may still be read again if the resume itself fails.
 */
export function restoreCtx(record: InFlightTurn): {
  ctx: InFlightTurn['ctx']
  activeNames: Set<string>
} {
  return {
    ctx: { ...record.ctx },
    activeNames: new Set(record.activeNames ?? []),
  }
}
