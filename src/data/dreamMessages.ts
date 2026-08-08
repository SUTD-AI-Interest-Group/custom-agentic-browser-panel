/**
 * The SW↔offscreen dreaming protocol — the counterpart to researchTasks.ts's
 * `ResearchMsg`, and small for the same reason the split is: only the
 * generation crosses over.
 *
 * The service worker cannot be the one to wait for a dream (Chrome kills it once
 * "a single request, such as an event or API call, takes longer than 5 minutes
 * to process" — measured: a 6-minute generation died with it), and the offscreen
 * document cannot decide when to dream (chrome.storage is unavailable there —
 * "the `runtime` API is the only extensions API supported by offscreen
 * documents"). So the worker sends a fully-resolved job one way and receives a
 * result the other way; see src/agent/dream.ts for which half does what.
 *
 * `token` is the dream lock the dispatching worker holds on the cycle's behalf.
 * It rides along so the worker that settles the result — possibly a *different*
 * instance, revived by the result message itself — releases exactly the lock it
 * took, and never one a later cycle has since claimed.
 */
import type { DreamCycleResult, DreamJob } from '../agent/dream'

export type DreamMsg =
  /** SW → offscreen: run this cycle. */
  | { type: 'dream.run'; token: string; job: DreamJob }
  /** offscreen → SW: the cycle finished (including "nothing to do"); record it. */
  | { type: 'dream.result'; token: string; result: DreamCycleResult }
  /** offscreen → SW: the cycle threw (model unreachable, host declined); drop the lock. */
  | { type: 'dream.failed'; token: string; error: string }

/**
 * Broadcast a dream message. Fire-and-forget with the rejection swallowed, like
 * `postResearchMsg`: a message nobody is listening for (the worker asleep, the
 * offscreen document gone) is a normal state here, not an error — the dream lock
 * expires on its own and the next alarm tick starts over.
 */
export function postDreamMsg(msg: DreamMsg): void {
  void chrome.runtime.sendMessage(msg).catch(() => {})
}
