import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountPresence, setTint, unmountPresence, unmountAllPresence } from './presence'

/**
 * A fake chrome.scripting.executeScript that records which injected function
 * ran against which tab. The inj* functions aren't exported (self-contained
 * for injection, per this file's own convention) but a real function
 * reference retains its `.name` even when unexported, so recording that is
 * enough to tell "the overlay was actually unmounted" apart from "it was only
 * mounted/tinted" without importing anything internal.
 */
function fakeChrome() {
  const calls: { tabId: number; fn: string }[] = []
  const chrome = {
    scripting: {
      executeScript: vi.fn(
        async ({ target, func }: { target: { tabId: number }; func: (...a: unknown[]) => void }) => {
          calls.push({ tabId: target.tabId, fn: func.name })
          return [{ result: undefined }]
        },
      ),
    },
  }
  return { chrome, calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// d11 F8 / W2-A's F7: `mounted` is a module-global registry shared by every
// mounted conversation (src/ui/tabChats.ts keeps more than one Chat instance
// running at once), so a blanket unmountAllPresence() at one chain's turn-end
// must not rip the overlay out from under a DIFFERENT, still-running chain's
// active page-control session. Distinct tab-id ranges per test avoid the
// shared module state leaking between cases.
describe('unmountAllPresence — scoped sweep (d11 F8 / W2-A F7)', () => {
  it('never unmounts a tab currently under active control (tinted) — only ambient-only tabs', async () => {
    const { chrome, calls } = fakeChrome()
    vi.stubGlobal('chrome', chrome)

    // Tab 501 stands in for a DIFFERENT conversation's live page-control
    // session (tinted); tab 502 is this chain's own leftover ambient mount
    // (NavigateTab / ReadPage "elements", no session ever opened on it).
    await mountPresence(501)
    await setTint(501, true)
    await mountPresence(502)

    calls.length = 0 // only care what the sweep itself does
    await unmountAllPresence()

    const unmounted = calls.filter((c) => c.fn === 'injUnmount').map((c) => c.tabId)
    expect(unmounted).toContain(502)
    expect(unmounted).not.toContain(501)
  })

  it('a tab under active control survives repeated sweeps, not just the first one', async () => {
    const { chrome, calls } = fakeChrome()
    vi.stubGlobal('chrome', chrome)

    await mountPresence(511)
    await setTint(511, true)
    await unmountAllPresence() // a different chain finishing (sweep #1)
    await unmountAllPresence() // yet another chain finishing (sweep #2)

    expect(calls.some((c) => c.fn === 'injUnmount' && c.tabId === 511)).toBe(false)

    // Its OWN session ending still tears it down precisely, on demand.
    calls.length = 0
    await unmountPresence(511) // Chat.tsx's teardownSession, via pageControl's endSession
    expect(calls.some((c) => c.fn === 'injUnmount' && c.tabId === 511)).toBe(true)
  })

  it('re-mounting an already-tinted tab (idempotent remount) does not demote it back to ambient', async () => {
    const { chrome, calls } = fakeChrome()
    vi.stubGlobal('chrome', chrome)

    await mountPresence(521)
    await setTint(521, true)
    await mountPresence(521) // e.g. ReadPage's idempotent ambient (re-)mount mid-session

    calls.length = 0
    await unmountAllPresence()
    expect(calls.some((c) => c.tabId === 521)).toBe(false)
  })

  it('still sweeps a genuinely ambient-only tab with no session at all', async () => {
    const { chrome, calls } = fakeChrome()
    vi.stubGlobal('chrome', chrome)

    await mountPresence(531)
    calls.length = 0
    await unmountAllPresence()
    expect(calls.some((c) => c.fn === 'injUnmount' && c.tabId === 531)).toBe(true)
  })

  it('untints on setTint(false) — a session that steps back to ambient is sweepable again', async () => {
    const { chrome, calls } = fakeChrome()
    vi.stubGlobal('chrome', chrome)

    await mountPresence(541)
    await setTint(541, true)
    await setTint(541, false)

    calls.length = 0
    await unmountAllPresence()
    expect(calls.some((c) => c.fn === 'injUnmount' && c.tabId === 541)).toBe(true)
  })
})

describe('mountPresence / setTint / unmountPresence — basic wiring (regression lock, no prior coverage)', () => {
  it('mountPresence injects injMount against the given tab', async () => {
    const { chrome, calls } = fakeChrome()
    vi.stubGlobal('chrome', chrome)

    await mountPresence(601)
    expect(calls).toEqual([{ tabId: 601, fn: 'injMount' }])
  })

  it('setTint injects injSetTint against the given tab', async () => {
    const { chrome, calls } = fakeChrome()
    vi.stubGlobal('chrome', chrome)

    await setTint(602, true)
    expect(calls).toEqual([{ tabId: 602, fn: 'injSetTint' }])
  })

  it('unmountPresence removes a tab regardless of tint state', async () => {
    const { chrome, calls } = fakeChrome()
    vi.stubGlobal('chrome', chrome)

    await mountPresence(603)
    await setTint(603, true)
    calls.length = 0
    await unmountPresence(603)
    expect(calls.some((c) => c.fn === 'injUnmount' && c.tabId === 603)).toBe(true)
  })
})
