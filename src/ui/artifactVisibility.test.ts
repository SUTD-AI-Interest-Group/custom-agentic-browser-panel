import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { artifactFrameReducer } from './artifactVisibility'

describe('artifactFrameReducer', () => {
  it('drops frameReady the instant the card goes off-screen', () => {
    // The iframe is about to be unmounted — whatever "ready" state it
    // reported is now meaningless.
    expect(artifactFrameReducer(true, { type: 'visibility', visible: false })).toBe(false)
  })

  it('does NOT optimistically mark ready when scrolling back into view', () => {
    // A freshly remounted iframe hasn't announced exec:ready yet — if this
    // returned true, the render effect would postMessage into a frame with
    // no listener attached, and the artifact would silently never reappear.
    expect(artifactFrameReducer(false, { type: 'visibility', visible: true })).toBe(false)
  })

  it('a frame-ready message always marks ready, regardless of prior state', () => {
    expect(artifactFrameReducer(false, { type: 'frame-ready' })).toBe(true)
    expect(artifactFrameReducer(true, { type: 'frame-ready' })).toBe(true)
  })

  it('staying visible while already ready leaves ready state unchanged', () => {
    expect(artifactFrameReducer(true, { type: 'visibility', visible: true })).toBe(true)
  })

  it('staying invisible while already not-ready leaves it unchanged', () => {
    expect(artifactFrameReducer(false, { type: 'visibility', visible: false })).toBe(false)
  })
})

// Integration guard: ArtifactCard.tsx must actually wire the reducer above up
// to real visibility observation, not just define it unused. An audit found
// every artifact card in a conversation stayed mounted and running (its
// sandboxed iframe's timers/animations/JS all still executing) for the whole
// life of the chat, with no virtualization — a long, artifact-heavy
// conversation accumulates an unbounded number of live sandboxed iframes.
// This can't be verified by driving a real IntersectionObserver under
// jsdom+vitest (none is polyfilled here, and .tsx files aren't collected by
// this project's test config — see CLAUDE.md), so it's checked the same way
// other Chrome/DOM-coupled invariants in this codebase are: a source-scan
// confirming the suspend/restore wiring is actually present, verified live
// via /verify-extension for the runtime behavior itself.
describe('ArtifactCard suspends off-screen artifacts', () => {
  const HERE = fileURLToPath(import.meta.url)
  const SRC = readFileSync(join(dirname(HERE), 'ArtifactCard.tsx'), 'utf-8')

  it('observes visibility and unmounts the iframe when off-screen', () => {
    expect(SRC).toMatch(/IntersectionObserver/)
    expect(SRC).toMatch(/artifactFrameReducer|artifactVisibility/)
  })
})
