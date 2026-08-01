// Pure decision logic behind ArtifactCard's suspend/restore behavior.
//
// Every CreateArtifact/UpdateArtifact card mounts a sandboxed iframe
// (sandbox-exec.html) that keeps running for as long as it's mounted — any
// timers, animations, or polling loops the artifact's own JS started keep
// executing. Before the first fix here, every artifact card in a
// conversation stayed mounted for the chat's whole life with no
// virtualization, so a long, artifact-heavy conversation accumulated an
// unbounded number of concurrently running sandboxed iframes.
//
// That first fix suspended a card once it scrolled far enough outside the
// viewport (an IntersectionObserver rootMargin) — but a review found this
// destroys a user's in-artifact state (a filled form, a configured chart, a
// running simulation) on an ORDINARY passive scroll: scroll down to read new
// messages, scroll back up, and an artifact you were mid-interaction with has
// silently reset. Controller decision: ordinary scrolling must never destroy
// artifact state. ArtifactLiveSet (below) replaces "suspend once far enough
// away" with "suspend only under genuine resource pressure" — an LRU cap on
// how many artifacts stay live across the whole side panel at once, evicting
// only the least-recently-visible one when a new one needs room. An artifact
// stays live — and its state intact — no matter how far it's scrolled, until
// enough OTHER artifacts have been seen more recently to push it out past the
// cap; scrolling back to it before that happens finds it exactly as it was
// left.
//
// Chosen semantics: suspending an artifact (by LRU eviction) still DESTROYS
// its live JS state (any in-progress timer/animation/user interaction inside
// the sandboxed page) — restoring re-renders the artifact fresh from its
// stored HTML, identical to what already happens on every first mount and on
// every UpdateArtifact revision bump today. This is not a new class of state
// loss: the CreateArtifact tool description already promises the artifact
// itself "no storage" (see tools.ts), and a revision bump already silently
// discards live state the same way. Only ArtifactCard's OWN UI state — the
// expand/collapse toggle — is unaffected by suspension, since that's this
// component's preference, not the artifact's internal state.
//
// The one rule that's easy to get backwards (and the reason this is
// extracted instead of living inline as two React effects): a freshly
// (re)mounted iframe must always wait for its OWN "exec:ready" message before
// anything posts a render command into it. If `frameReady` from the
// suspended iframe's lifetime survived into the new iframe's lifetime, the
// render effect would fire a postMessage at a frame that hasn't attached its
// listener yet — dropped silently, so the artifact would just never render
// after being restored. Suspending must therefore always drop `frameReady`
// back to false; becoming visible again must NOT optimistically set it back
// to true — only the new iframe's own "exec:ready" may do that. This holds
// regardless of WHY visibility changed (distance before, LRU pressure now).

export type ArtifactFrameEvent =
  | { type: 'visibility'; visible: boolean }
  | { type: 'frame-ready' }

export function artifactFrameReducer(frameReady: boolean, event: ArtifactFrameEvent): boolean {
  if (event.type === 'frame-ready') return true
  return event.visible ? frameReady : false
}

/**
 * Tracks which artifacts are allowed to stay mounted ("live") at once across
 * the whole side panel, evicting the least-recently-visible entry once a new
 * one needs room. See this module's header for why suspension is gated on
 * this instead of on scroll distance.
 *
 * An id that has never been touched at all is live by default (`isLive`
 * returns true) — a brand-new artifact must render immediately rather than
 * flash a placeholder for one frame, matching ArtifactCard's existing
 * "assume visible until observed otherwise" behavior. Only an id actually
 * pushed out by LRU pressure counts as suspended.
 *
 * Framework-free by design (no React import) so the eviction/LRU logic is
 * directly unit-testable; ArtifactCard subscribes to it via
 * `useSyncExternalStore` (this class's `subscribe` plus a per-card
 * `() => artifactLiveSet.isLive(artifactId)` snapshot getter) — the one bit
 * that needs a browser DOM to exercise, checked by the source-scan below
 * instead.
 */
export class ArtifactLiveSet {
  // Ids currently counted as live, least-recently-visible first — never
  // longer than `capacity`.
  private order: string[] = []
  // Ids explicitly pushed out by LRU pressure. Anything NOT in this set is
  // live, including an id that's never been touched at all (see class doc).
  private evicted = new Set<string>()
  private listeners = new Set<() => void>()

  constructor(private readonly capacity: number) {}

  /**
   * Mark `id` visible right now: bump it to most-recently-used (restoring it
   * if it was suspended), evicting the least-recently-visible OTHER entry if
   * this pushes the live set past capacity. Notifies subscribers only when
   * some id's `isLive` result actually flips — plain reordering among
   * already-live ids (the common case: ordinary scrolling within the cap)
   * changes nothing observable, so it stays silent.
   */
  touch(id: string): void {
    this.order = this.order.filter((x) => x !== id)
    this.order.push(id)
    let changed = this.evicted.delete(id)
    while (this.order.length > this.capacity) {
      const oldest = this.order.shift()
      if (oldest !== undefined) {
        this.evicted.add(oldest)
        changed = true
      }
    }
    if (changed) this.notify()
  }

  /**
   * Forget `id` entirely — its card unmounted for good (the message was
   * deleted or regenerated away), not merely scrolled off-screen. A no-op
   * for anyone's `isLive` result unless `id` was currently suspended (in
   * which case forgetting it also counts as restoring it, so that's
   * reported too); removing a live id just frees its LRU slot.
   */
  remove(id: string): void {
    this.order = this.order.filter((x) => x !== id)
    if (this.evicted.delete(id)) this.notify()
  }

  /** True unless `id` has been explicitly pushed out by LRU pressure. */
  isLive(id: string): boolean {
    return !this.evicted.has(id)
  }

  /** React's `useSyncExternalStore` subscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

/**
 * Shared across every ArtifactCard in the side panel — see ArtifactLiveSet's
 * own comment. Capacity chosen generously: a typical conversation, even an
 * artifact-heavy one, keeps far fewer than this many artifacts
 * simultaneously relevant, so almost nobody ever hits the cap; a
 * pathological long conversation still gets a hard, small ceiling on
 * concurrently running sandboxed iframes instead of the unbounded growth
 * this module was originally built to fix.
 */
export const ARTIFACT_LIVE_CAPACITY = 8
export const artifactLiveSet = new ArtifactLiveSet(ARTIFACT_LIVE_CAPACITY)
