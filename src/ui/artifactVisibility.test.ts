import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { artifactFrameReducer, ArtifactLiveSet } from './artifactVisibility'

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

// R4 regression: the ORIGINAL fix here suspended a card purely by scroll
// distance (an IntersectionObserver rootMargin) — which meant an ordinary,
// passive scroll (down to read new messages, then back up) could destroy a
// user's in-artifact state (a filled form, a configured chart, a running
// simulation) even though nothing was actually short on resources. The
// controller's decision: ordinary scrolling must NEVER destroy artifact
// state. ArtifactLiveSet replaces "suspend once far enough off-screen" with
// "suspend only once genuinely under LRU pressure" — an artifact stays live
// no matter how far it's scrolled, until enough OTHER artifacts have been
// seen more recently to push it out past the cap.
describe('ArtifactLiveSet — suspension gated on genuine pressure, not scroll distance', () => {
  it('an id that has never been touched is live by default — a brand-new artifact must render immediately, never flash a placeholder', () => {
    const set = new ArtifactLiveSet(2)
    expect(set.isLive('brand-new')).toBe(true)
  })

  it('touching within capacity never evicts anything — this is what makes ordinary scrolling harmless', () => {
    const set = new ArtifactLiveSet(3)
    set.touch('a')
    set.touch('b')
    // Scrolling back and forth across the same two cards, repeatedly — pure
    // ordinary scrolling, never introducing a third concurrently-relevant
    // artifact — must never suspend either one, no matter how many times.
    for (let i = 0; i < 20; i++) {
      set.touch(i % 2 === 0 ? 'a' : 'b')
      expect(set.isLive('a')).toBe(true)
      expect(set.isLive('b')).toBe(true)
    }
  })

  it('exceeding capacity evicts the least-recently-visible entry, never the most recent', () => {
    const set = new ArtifactLiveSet(2)
    set.touch('a')
    set.touch('b')
    set.touch('c') // capacity 2 — 'a' (least-recently-visible) is evicted
    expect(set.isLive('a')).toBe(false)
    expect(set.isLive('b')).toBe(true)
    expect(set.isLive('c')).toBe(true)
  })

  it('proof: scrolling away and back preserves state — revisiting an artifact protects it from eviction relative to one not revisited', () => {
    const set = new ArtifactLiveSet(2)
    set.touch('a') // artifact A created/first seen
    set.touch('b') // scroll down to B
    set.touch('a') // scroll BACK UP to A — ordinary scrolling, revisits it
    set.touch('c') // scroll down further, C becomes relevant — capacity now exceeded
    // B, not A, is evicted: A was seen more recently than B at the moment
    // pressure hit, exactly modeling "scrolled away and back" beating out
    // something that was never revisited.
    expect(set.isLive('b')).toBe(false)
    expect(set.isLive('a')).toBe(true)
    expect(set.isLive('c')).toBe(true)
  })

  it('touching an evicted id restores it to live — a suspended artifact scrolled back into view remounts and rejoins the live set', () => {
    const set = new ArtifactLiveSet(1)
    set.touch('a')
    set.touch('b') // evicts 'a'
    expect(set.isLive('a')).toBe(false)
    set.touch('a') // scrolled back to — restores it, evicting 'b' instead
    expect(set.isLive('a')).toBe(true)
    expect(set.isLive('b')).toBe(false)
  })

  it('remove() forgets an id entirely — a later touch (or the live-by-default rule) treats it as brand new again', () => {
    const set = new ArtifactLiveSet(1)
    set.touch('a')
    set.touch('b') // evicts 'a'
    expect(set.isLive('a')).toBe(false)
    set.remove('a')
    expect(set.isLive('a')).toBe(true) // untouched-and-forgotten defaults live, same as brand new
  })

  it('notifies subscribers only when an eviction (or restoration) actually changes who is live', () => {
    const set = new ArtifactLiveSet(2)
    set.touch('a')
    set.touch('b')
    let notifications = 0
    set.subscribe(() => notifications++)
    set.touch('a') // already live, still within capacity — no observable change
    expect(notifications).toBe(0)
    set.touch('c') // exceeds capacity — 'b' evicted, a genuine change
    expect(notifications).toBe(1)
  })

  it('unsubscribe stops further notifications', () => {
    const set = new ArtifactLiveSet(1)
    let count = 0
    const unsubscribe = set.subscribe(() => count++)
    set.touch('a')
    set.touch('b') // evicts 'a' — notifies
    expect(count).toBe(1)
    unsubscribe()
    set.touch('c') // would evict 'b', but the listener already unsubscribed
    expect(count).toBe(1)
  })
})

// Integration guard: ArtifactCard.tsx must actually wire the reducer and the
// shared LRU above up to real visibility observation, not just define them
// unused. This can't be verified by driving a real IntersectionObserver
// under jsdom+vitest (none is polyfilled here, and .tsx files aren't
// collected by this project's test config — see CLAUDE.md), so it's checked
// the same way other Chrome/DOM-coupled invariants in this codebase are: a
// source-scan confirming the wiring is actually present, verified live via
// /verify-extension for the runtime behavior itself.
describe('ArtifactCard suspends only under LRU pressure, never merely from scrolling', () => {
  const HERE = fileURLToPath(import.meta.url)
  const SRC = readFileSync(join(dirname(HERE), 'ArtifactCard.tsx'), 'utf-8')

  it('observes visibility and wires the shared LRU rather than gating suspension on distance alone', () => {
    expect(SRC).toMatch(/IntersectionObserver/)
    expect(SRC).toMatch(/artifactFrameReducer|artifactVisibility/)
    expect(SRC).toMatch(/artifactLiveSet/)
    expect(SRC).toMatch(/useSyncExternalStore/)
  })
})
