/**
 * A monotonic "only the newest answer wins" token, for async work whose result
 * is written into shared state.
 *
 * The composer's `@` and `/` menus each fire an async refresh per keystroke
 * (`listOpenTabs()`, `listSkills()`, plus an MCP round-trip), and each one ends
 * by overwriting the whole candidate list. Nothing sequenced them, so two
 * refreshes in flight resolved in whatever order their awaits happened to
 * settle: type `@gi` quickly and the slower `@g` lookup could land last,
 * leaving the menu showing matches for a query the composer no longer holds.
 * Enter then picks a candidate the user never saw offered — the failure is
 * silent and looks like the picker "choosing the wrong tab".
 *
 * Guarding with a plain boolean or an AbortController does not fit here: these
 * refreshes are cheap and un-cancellable (`chrome.tabs.query` has no signal),
 * so the right move is not to stop them but to ignore the stale one's result.
 *
 * Kept pure and React-free so the ordering logic is unit-testable without
 * mounting a component; a caller holds one instance per menu in a ref.
 */

/** Issues request tokens and reports whether a given one is still the newest. */
export interface LatestRequest {
  /** Claim the next token. The caller passes it back to `isStale` after awaiting. */
  next(): number
  /** True once a NEWER token has been issued — the caller must drop its result. */
  isStale(token: number): boolean
}

/**
 * Create an independent sequence. One per list being written: sharing a single
 * counter between the mention menu and the slash menu would let a keystroke in
 * one silently invalidate an in-flight refresh of the other.
 */
export function createLatestRequest(): LatestRequest {
  let latest = 0
  return {
    next: () => ++latest,
    isStale: (token: number) => token !== latest,
  }
}
