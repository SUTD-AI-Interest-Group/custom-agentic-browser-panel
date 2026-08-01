// Pure decision logic behind ArtifactCard's suspend/restore behavior.
//
// Every CreateArtifact/UpdateArtifact card mounts a sandboxed iframe
// (sandbox-exec.html) that keeps running for as long as it's mounted — any
// timers, animations, or polling loops the artifact's own JS started keep
// executing. Before this fix every artifact card in a conversation stayed
// mounted for the chat's whole life with no virtualization, so a long,
// artifact-heavy conversation accumulated an unbounded number of concurrently
// running sandboxed iframes. ArtifactCard now unmounts the iframe once it's
// scrolled well outside the viewport (via IntersectionObserver, the DOM/React
// half — untestable here without a browser) and remounts it on demand when
// scrolled back near the viewport.
//
// Chosen semantics: suspending an artifact DESTROYS its live JS state (any
// in-progress timer/animation/user interaction inside the sandboxed page) —
// restoring re-renders the artifact fresh from its stored HTML, identical to
// what already happens on every first mount and on every UpdateArtifact
// revision bump today. This is not a new class of state loss: the
// CreateArtifact tool description already promises the artifact itself "no
// storage" (see tools.ts), and a revision bump already silently discards
// live state the same way. Only ArtifactCard's OWN UI state — the
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
// to true — only the new iframe's own "exec:ready" may do that.

export type ArtifactFrameEvent =
  | { type: 'visibility'; visible: boolean }
  | { type: 'frame-ready' }

export function artifactFrameReducer(frameReady: boolean, event: ArtifactFrameEvent): boolean {
  if (event.type === 'frame-ready') return true
  return event.visible ? frameReady : false
}
