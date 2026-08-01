/**
 * A FIFO queue of pending human-approval requests.
 *
 * Chat.tsx shows exactly one approval card at a time, but the Vercel AI SDK
 * runs every tool call from one model step concurrently (`Promise.all`), so
 * two gated tools in the same step — two `RunCode` calls, `RunCode` +
 * `CreateArtifact`, `RequestPageControl` alongside either — is the default
 * case, not an edge case (see CLAUDE.md's approval-gate invariant). A second
 * request while the first is still outstanding must queue behind it, not
 * silently replace it: an overwritten request's `resolve` callback would
 * never be called again, permanently hanging the tool's `execute()` call
 * (and, with it, the model step, the turn, and the whole chat — see the
 * requestApproval CRITICAL finding this module fixes).
 *
 * Kept pure and Chrome/React-free so this multi-request behavior is directly
 * unit-testable without mounting Chat.
 */
export class ApprovalQueue<T> {
  private items: Array<{ request: T; resolve: (approved: boolean) => void }> = []

  /** The request currently shown to the user, or null if none is pending. */
  get front(): T | null {
    return this.items[0]?.request ?? null
  }

  /** How many requests are waiting, including the visible front one. */
  get size(): number {
    return this.items.length
  }

  /**
   * Enqueue a request. The returned promise resolves once this request is
   * answered — immediately if it becomes the front (the queue was empty), or
   * once every earlier request has settled. `front` reflects the new state
   * synchronously (the executor above runs synchronously), so a caller that
   * needs to sync visible UI (e.g. show the card) can read it right after
   * calling this.
   */
  request(req: T): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.items.push({ request: req, resolve })
    })
  }

  /**
   * Resolve the front request with `approved`, remove it from the queue, and
   * reveal whatever's queued behind it. Returns the new front (or null if the
   * queue is now empty) so the caller can sync visible UI state. A harmless
   * no-op (returns null) if nothing is pending.
   */
  settleFront(approved: boolean): T | null {
    const entry = this.items.shift()
    entry?.resolve(approved)
    return this.front
  }

  /**
   * Resolve every pending request — front and everything queued behind it —
   * with the same verdict, and empty the queue. Used when the whole turn is
   * ending (Stop, chain teardown): nothing should be left dangling just
   * because only the front was ever shown, and no further card should pop up
   * once the user or the chain has moved on.
   */
  drainAll(approved: boolean): void {
    const entries = this.items
    this.items = []
    for (const entry of entries) entry.resolve(approved)
  }
}
