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
 * Every request is settled by identity (see `settle`), never by "whatever
 * happens to be at the front" — an answer can only ever apply to the exact
 * card it was captured for. This closes a second, narrower gap an
 * adversarial review found: a rapid double-click meant for ONE card could
 * settle the card that slid into its place, auto-answering something the
 * user never actually saw. `settle` rejects that two ways — a stale id (the
 * queue already moved on since the caller captured it) and a fresh id
 * arriving suspiciously soon after its card became the front (the literal
 * second click of a double-click, not a stale reference at all — see its
 * own doc comment).
 *
 * Kept pure and Chrome/React-free so all of this is directly unit-testable
 * without mounting Chat.
 */
export class ApprovalQueue<T> {
  private items: Array<{
    id: number
    request: T
    resolve: (approved: boolean) => void
    revealedAt: number
  }> = []
  private nextId = 0

  /** The request currently shown to the user, or null if none is pending. */
  get front(): T | null {
    return this.items[0]?.request ?? null
  }

  /**
   * Identity of the request currently at the front, or null if none is
   * pending. The UI must capture this alongside whatever it renders for the
   * front card and carry it through to `settle` — never assume "the front"
   * still means the same card by the time the user's click actually arrives.
   */
  get frontId(): number | null {
    return this.items[0]?.id ?? null
  }

  /** How many requests are waiting, including the visible front one. */
  get size(): number {
    return this.items.length
  }

  /**
   * Enqueue a request. The returned promise resolves once this request is
   * answered — immediately if it becomes the front (the queue was empty), or
   * once every earlier request has settled. `front`/`frontId` reflect the new
   * state synchronously (the executor above runs synchronously), so a caller
   * that needs to sync visible UI (e.g. show the card) can read them right
   * after calling this. `now` is injectable for deterministic tests; real
   * call sites always take the default.
   */
  request(req: T, now = Date.now()): Promise<boolean> {
    const id = this.nextId++
    return new Promise<boolean>((resolve) => {
      // revealedAt only matters once this item is genuinely the front —
      // settle() re-stamps it at that moment for anything queued behind an
      // existing one, so the value stamped here is only ever "live" for the
      // empty-queue case (this item becomes the front immediately).
      this.items.push({ id, request: req, resolve, revealedAt: now })
    })
  }

  /**
   * Resolve the request identified by `id` — but only if it is genuinely
   * still the front of the queue AND has been visible for at least
   * `MIN_VISIBLE_MS` — remove it, and reveal whatever's queued behind it.
   * Returns `{ settled: false, front }` (the CURRENT front, unchanged) as a
   * harmless no-op whenever either check fails, so the caller can tell "my
   * answer actually applied" from "nothing happened, don't touch anything
   * else (session grants, side effects, ...)".
   *
   * The id check closes the gap a stale reference leaves open: if the queue
   * has already advanced past `id` (someone else settled it, or Stop drained
   * the queue) since the caller captured it, this call must not reach
   * forward and silently answer whatever now happens to be showing.
   *
   * The visibility check closes a narrower, purely-timing gap the id check
   * alone can't: the instant one card is dismissed and the next slides into
   * view, a fresh, CORRECTLY-bound click can still land on that newcomer —
   * the second click of a plain human double-click aimed at the card that
   * just disappeared is easily fast enough to hit the button now occupying
   * the same screen position, and its captured id genuinely matches (this
   * isn't a stale reference — it's a real click on a card the user never
   * actually read). MIN_VISIBLE_MS is comfortably longer than a literal
   * double-click gesture (browsers/OSes typically recognize one within
   * 200–500ms of the first click) but short enough that a deliberate,
   * separate decision never feels delayed.
   */
  settle(id: number, approved: boolean, now = Date.now()): { settled: boolean; front: T | null } {
    const head = this.items[0]
    if (!head || head.id !== id || now - head.revealedAt < MIN_VISIBLE_MS) {
      return { settled: false, front: this.front }
    }
    this.items.shift()
    head.resolve(approved)
    const next = this.items[0]
    if (next) next.revealedAt = now // becomes the front NOW, however long it sat queued
    return { settled: true, front: this.front }
  }

  /**
   * Resolve every pending request — front and everything queued behind it —
   * with the same verdict, and empty the queue. Used when the whole turn is
   * ending (Stop, chain teardown): nothing should be left dangling just
   * because only the front was ever shown, and no further card should pop up
   * once the user or the chain has moved on. Deliberately bypasses both of
   * settle()'s checks — this is a hard stop, not an answer to any one card.
   */
  drainAll(approved: boolean): void {
    const entries = this.items
    this.items = []
    for (const entry of entries) entry.resolve(approved)
  }
}

/**
 * Minimum time a card must have been the visible front before a `settle()`
 * for it is honored — see `settle`'s own doc comment for why this exists
 * alongside the id check.
 */
export const MIN_VISIBLE_MS = 400
