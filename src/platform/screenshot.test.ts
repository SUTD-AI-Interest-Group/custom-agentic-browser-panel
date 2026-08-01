import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  planStitch,
  planTiles,
  planShotDelivery,
  fitTileDimensions,
  throttledCaptureVisibleTab,
  extendPlan,
} from './screenshot'

// The stitch plan is the only place the scroll/crop arithmetic lives, and its
// hard case — the bottom of a document, where the page refuses to scroll far
// enough and the last shot re-shows pixels we already have — is invisible in a
// screenshot until you look closely. So it is pinned down here.

describe('planStitch', () => {
  it('takes a single slice when the content fits in the viewport', () => {
    const plan = planStitch({ contentTop: 0, contentHeight: 300, clientHeight: 800, maxScrollY: 0 })
    expect(plan.slices).toEqual([{ scrollTo: 0, srcY: 0, srcH: 300, destY: 0 }])
    expect(plan.height).toBe(300)
    expect(plan.truncated).toBe(false)
  })

  it('walks the page in viewport-sized steps, skipping the overlap on the last slice', () => {
    // 1000px page, 400px viewport => the page can only scroll to 600. The third
    // slice therefore shows [600,1000) when we wanted [800,1000): the top 200px
    // of that shot duplicate slice two, so srcY skips them.
    const plan = planStitch({ contentTop: 0, contentHeight: 1000, clientHeight: 400, maxScrollY: 600 })
    expect(plan.slices).toEqual([
      { scrollTo: 0, srcY: 0, srcH: 400, destY: 0 },
      { scrollTo: 400, srcY: 0, srcH: 400, destY: 400 },
      { scrollTo: 600, srcY: 200, srcH: 200, destY: 800 },
    ])
    expect(plan.height).toBe(1000)
    expect(plan.truncated).toBe(false)
  })

  it('needs no overlap when the page divides evenly', () => {
    const plan = planStitch({ contentTop: 0, contentHeight: 1200, clientHeight: 400, maxScrollY: 800 })
    expect(plan.slices.map((s) => s.srcY)).toEqual([0, 0, 0])
    expect(plan.slices.map((s) => s.scrollTo)).toEqual([0, 400, 800])
    expect(plan.height).toBe(1200)
  })

  it('captures an element that sits below the fold, starting at its top', () => {
    // Element at y=1500, 1000 tall, in a 5000px document with a 400px viewport.
    const plan = planStitch({
      contentTop: 1500,
      contentHeight: 1000,
      clientHeight: 400,
      maxScrollY: 4600,
    })
    expect(plan.slices).toEqual([
      { scrollTo: 1500, srcY: 0, srcH: 400, destY: 0 },
      { scrollTo: 1900, srcY: 0, srcH: 400, destY: 400 },
      { scrollTo: 2300, srcY: 0, srcH: 200, destY: 800 },
    ])
    expect(plan.height).toBe(1000)
  })

  it('clamps and de-overlaps an element pressed against the bottom of the document', () => {
    // Element ends at 4900 in a 5000px doc; the page cannot scroll past 4600, so
    // the second shot starts 200px above where we asked and must skip that much.
    const plan = planStitch({
      contentTop: 4400,
      contentHeight: 500,
      clientHeight: 400,
      maxScrollY: 4600,
    })
    expect(plan.slices).toEqual([
      { scrollTo: 4400, srcY: 0, srcH: 400, destY: 0 },
      { scrollTo: 4600, srcY: 200, srcH: 100, destY: 400 },
    ])
    expect(plan.height).toBe(500)
  })

  it('always produces a contiguous, gap-free output', () => {
    // The invariant that matters: every slice lands exactly where the previous
    // one ended, so the stitched image has no seams and no lost rows.
    const plan = planStitch({ contentTop: 137, contentHeight: 2333, clientHeight: 617, maxScrollY: 9000 })
    let expected = 0
    for (const s of plan.slices) {
      expect(s.destY).toBe(expected)
      expect(s.srcY).toBeGreaterThanOrEqual(0)
      expect(s.srcH).toBeGreaterThan(0)
      expect(s.srcY + s.srcH).toBeLessThanOrEqual(617)
      expected += s.srcH
    }
    expect(expected).toBe(plan.height)
    expect(plan.height).toBe(2333)
  })

  it('truncates a page taller than the height cap, and says so', () => {
    const plan = planStitch({
      contentTop: 0,
      contentHeight: 100_000,
      clientHeight: 1000,
      maxScrollY: 99_000,
      maxHeight: 5000,
      maxSlices: 50,
    })
    expect(plan.height).toBe(5000)
    expect(plan.slices).toHaveLength(5)
    expect(plan.truncated).toBe(true)
  })

  it('truncates when the slice budget runs out before the height cap does', () => {
    const plan = planStitch({
      contentTop: 0,
      contentHeight: 10_000,
      clientHeight: 1000,
      maxScrollY: 9000,
      maxHeight: 20_000,
      maxSlices: 3,
    })
    expect(plan.slices).toHaveLength(3)
    expect(plan.height).toBe(3000)
    expect(plan.truncated).toBe(true)
  })

  it('refuses to plan against a zero-height viewport instead of looping forever', () => {
    expect(planStitch({ contentTop: 0, contentHeight: 900, clientHeight: 0, maxScrollY: 0 })).toEqual({
      slices: [],
      height: 0,
      truncated: false,
    })
  })

  it('returns nothing for an element with no height', () => {
    expect(planStitch({ contentTop: 10, contentHeight: 0, clientHeight: 800, maxScrollY: 0 }).slices).toEqual([])
  })
})

describe('planTiles', () => {
  it('leaves a short image as one tile', () => {
    expect(planTiles(900, 1400, 6)).toEqual({ tiles: [{ y: 0, h: 900 }], dropped: 0 })
  })

  it('splits a tall image into full-height bands plus a remainder', () => {
    expect(planTiles(3000, 1400, 6)).toEqual({
      tiles: [
        { y: 0, h: 1400 },
        { y: 1400, h: 1400 },
        { y: 2800, h: 200 },
      ],
      dropped: 0,
    })
  })

  it('divides evenly with no remainder band', () => {
    expect(planTiles(2800, 1400, 6).tiles).toEqual([
      { y: 0, h: 1400 },
      { y: 1400, h: 1400 },
    ])
  })

  it('drops tiles past the budget from the tail and reports how many', () => {
    // Images are the most expensive thing the agent can do; the tail is dropped
    // loudly (the tool tells the model) rather than silently.
    const plan = planTiles(10_000, 1400, 3)
    expect(plan.tiles).toHaveLength(3)
    expect(plan.tiles.at(-1)).toEqual({ y: 2800, h: 1400 })
    expect(plan.dropped).toBe(5)
  })

  it('handles a degenerate image', () => {
    expect(planTiles(0, 1400, 6)).toEqual({ tiles: [], dropped: 0 })
  })

  // Regression for the C2 bug: `capture()` used to hand the model an already
  // fit()-downscaled (≤1400px-tall) canvas as the tiling SOURCE, so a tall page
  // could never produce more than one (illegible) tile — planTiles(shot.height, …)
  // never saw a height above MAX_SIDE. The fix is that `tileShot` now receives
  // the FULL-RESOLUTION stitched canvas (see `capture()`'s `shot` vs `artifact`
  // split, and `tileShot` in screenshot.ts); this pins the planner-level intent
  // that a genuinely tall source must fan out into several full-res tiles, not
  // collapse to one. The Chrome/canvas plumbing that actually keeps the tiling
  // source at full resolution cannot run under vitest (no DOM/canvas/chrome.*
  // here) — that end-to-end path is exercised by the `/verify-extension` flow
  // in a real browser, capturing a page tall enough to require multiple tiles.
  it('a full-resolution (un-fit) tall source yields more than one tile — the model must see it in bands', () => {
    const plan = planTiles(8000, 1400, 6)
    expect(plan.tiles.length).toBeGreaterThan(1)
    expect(plan.tiles.every((t) => t.h <= 1400)).toBe(true)
    // Every tile still full-res on its vertical extent; only the LAST one is a
    // shorter remainder — none are the single downscaled smear the bug produced.
    const total = plan.tiles.reduce((sum, t) => sum + t.h, 0)
    expect(total).toBe(8000)
  })
})

describe('planShotDelivery', () => {
  it('text-only model: never sends an image — the shot is saved for the user only', () => {
    // The reversed invariant: a blind model still captures (for the user), but no
    // tiles are queued and the caller must tell it plainly, so it does not loop.
    expect(planShotDelivery(false, 0, 12)).toEqual({ kind: 'blind' })
    expect(planShotDelivery(false, 5, 12)).toEqual({ kind: 'blind' })
  })

  it('vision model with budget left: sends up to the remaining per-turn budget', () => {
    expect(planShotDelivery(true, 0, 12)).toEqual({ kind: 'send', maxTiles: 12 })
    expect(planShotDelivery(true, 10, 12)).toEqual({ kind: 'send', maxTiles: 2 })
  })

  it('vision model, budget spent: saves for the user but sends nothing to the model', () => {
    expect(planShotDelivery(true, 12, 12)).toEqual({ kind: 'budget' })
    expect(planShotDelivery(true, 20, 12)).toEqual({ kind: 'budget' })
  })
})

// Regression for the tile-squashing bug: tileShot()'s cropTile() used to run
// each tile through fit(), which scales BOTH axes uniformly by
// min(1, MAX_SIDE/max(w,h)). Since a tile's height is capped at MAX_SIDE by
// construction (planTiles(shot.height, MAX_SIDE, …)), the oversized axis on a
// HiDPI or wide capture is almost always width — and a uniform scale drags
// height down by the same factor, silently violating tileShot's own
// documented contract ("height stays full-res — that's the point"). A
// dpr=2, 1512-CSS-wide viewport's first tile (3024x1400 device px) used to
// come out 1400x648: 54% of vertical detail lost, with no flag anywhere.
//
// fitTileDimensions replaces the uniform scale with an independent per-axis
// clamp for tiles specifically (fit() itself is untouched and still used for
// the single downscaled artifact strip saved for the user, where uniform
// scaling is correct — see capture()'s shot/artifact split).
describe('fitTileDimensions', () => {
  // Table-driven over real device geometries. Each row's `height` is what a
  // real tile height would be for that geometry — i.e. min(MAX_SIDE,
  // remainder) — which is always <= 1400 by planTiles' own construction, so
  // every row's expected height equals its input height verbatim.
  const MAX_SIDE = 1400
  const cases: Array<{ label: string; width: number; height: number }> = [
    // 1x DPR, narrow-tall viewport (phone-like), page shorter than one
    // viewport — both axes already under the cap: a pure no-op sanity check.
    { label: '1x DPR, narrow viewport, page shorter than one viewport (no clamp needed)', width: 390, height: 600 },
    // 2x DPR, wide-short viewport (a 1512-CSS-wide MacBook display) — the
    // auditor's own headline numbers: first tile of a two-tile stitch.
    { label: '2x DPR, wide viewport, first of two tiles (the audit\'s own repro numbers)', width: 3024, height: 1400 },
    // Same geometry, second (remainder) tile.
    { label: '2x DPR, wide viewport, second/remainder tile', width: 3024, height: 400 },
    // 3x DPR, narrow-tall viewport (iPhone-Pro-like), page exactly 2
    // viewports tall — no remainder band, both tiles hit MAX_SIDE exactly.
    { label: '3x DPR, narrow viewport, page exactly 2 viewports tall, tile 1', width: 1179, height: 1400 },
    { label: '3x DPR, narrow viewport, page exactly 2 viewports tall, tile 2', width: 1179, height: 1400 },
    // A page 1px taller than N viewports — a tiny 1px remainder tile paired
    // with a wide/HiDPI width. Height must stay exactly 1, not vanish or grow.
    { label: 'page 1px taller than N viewports — tiny remainder tile, wide width', width: 3024, height: 1 },
    // Extremely tall (infinite-scroll-class) page: the LAST surviving tile
    // before planTiles' maxTiles cap drops the rest — still full height.
    { label: 'extremely tall page, last surviving tile before the tile-count cap', width: 3024, height: 1400 },
    // 1x DPR but a genuinely wide monitor/window (not a HiDPI artifact at
    // all) — proves the bug is about width > maxSide, not about DPR per se.
    { label: '1x DPR, ultra-wide short viewport, single slice', width: 2560, height: 700 },
  ]

  it.each(cases)('$label: height is never downscaled', ({ width, height }) => {
    expect(fitTileDimensions(width, height, MAX_SIDE)).toEqual({
      width: Math.min(width, MAX_SIDE),
      height, // the documented invariant, asserted directly — not a specific number
    })
  })

  it('the audit\'s exact repro number: a 3024x1400 tile keeps full-resolution height', () => {
    // This is the literal case from the finding: under the old uniform fit(),
    // this yielded {width:1400, height:648} — 54% of vertical detail lost.
    expect(fitTileDimensions(3024, 1400, 1400)).toEqual({ width: 1400, height: 1400 })
  })

  it('never downscales height regardless of how oversized width is (documented invariant, broad sweep)', () => {
    // Every real tile height is <= maxSide by construction; sweep a wide
    // range of widths (including absurd ones) against every plausible tile
    // height and assert height is always returned unchanged.
    const heights = [1, 50, 400, 648, 900, 1400]
    const widths = [100, 1399, 1400, 1401, 2000, 3024, 5000, 7680]
    for (const height of heights) {
      for (const width of widths) {
        expect(fitTileDimensions(width, height, 1400).height).toBe(height)
      }
    }
  })

  it('clamps width only when it exceeds maxSide, and leaves it untouched otherwise', () => {
    expect(fitTileDimensions(1000, 900, 1400).width).toBe(1000) // under cap: untouched
    expect(fitTileDimensions(1400, 900, 1400).width).toBe(1400) // exactly at cap: untouched
    expect(fitTileDimensions(3024, 900, 1400).width).toBe(1400) // over cap: clamped
  })

  it('defensively clamps height too, if a future caller ever violates the by-construction guarantee', () => {
    // Not reachable via tileShot() today (planTiles caps every tile height at
    // MAX_SIDE) — but the clamp must stay independent (never proportional)
    // even in this defensive case, so a hypothetical oversized-height input
    // never drags width down with it either.
    expect(fitTileDimensions(500, 2000, 1400)).toEqual({ width: 500, height: 1400 })
  })
})

// Regression for the shared-throttle bypass: capture.ts (the human region
// picker) and marks.ts (the set-of-marks screenshot) used to call
// chrome.tabs.captureVisibleTab directly, with zero awareness of this
// module's own ~550ms quota clock — so chaining, e.g., ReadPage(mode:
// "elements") immediately followed by GetScreenshot could issue two calls
// inside Chrome's ~2/sec window and trip its quota. throttledCaptureVisibleTab
// is now the ONE way anything in the extension may call captureVisibleTab.
describe('throttledCaptureVisibleTab', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('spaces consecutive calls by the Chrome quota interval instead of letting the second through immediately', async () => {
    vi.useFakeTimers()
    const callTimes: number[] = []
    vi.stubGlobal('chrome', {
      tabs: {
        captureVisibleTab: vi.fn(async () => {
          callTimes.push(Date.now())
          return 'data:image/png;base64,x'
        }),
      },
    })

    // First call: the module's internal clock starts at 0, and fake "now" is
    // a real, much-later timestamp, so nothing should block this one.
    await throttledCaptureVisibleTab(1)
    expect(callTimes).toHaveLength(1)

    // Second call, fired back-to-back with no time elapsed: must NOT reach
    // captureVisibleTab immediately — it has to wait out the quota window.
    const second = throttledCaptureVisibleTab(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(callTimes).toHaveLength(1) // still just the first — second is blocked

    await vi.advanceTimersByTimeAsync(600)
    await second
    expect(callTimes).toHaveLength(2)
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(550)
  })
})

// Regression for the infinite-scroll under-capture bug: captureFullPage used
// to size its ENTIRE stitch plan from a single scrollHeight measurement taken
// BEFORE the first scroll. A page whose content grows AS you scroll (feeds,
// lazy-appended lists) is taller by the time the stitch finishes than that
// one measurement said — but nothing ever re-measured, so `truncated` stayed
// false and the result claimed "the full page" while substantially more
// content had since loaded beneath what was captured. extendPlan is the pure
// decision: given a plan that already ran and a FRESH live measurement, add
// slices for newly-discovered content (continuing in canvas space from where
// the original plan left off), bounded by the same maxHeight/maxSlices
// budget every plan already respects — or honestly flag `truncated` when
// that budget is already spent.
describe('extendPlan', () => {
  it('extends a plan to cover content that grew after it was computed (the infinite-scroll case)', () => {
    // The finding's own example numbers: an initial plan from contentHeight
    // 3000, then a live observation that the page is now 6000 tall.
    const plan = planStitch({ contentTop: 0, contentHeight: 3000, clientHeight: 1000, maxScrollY: 2000 })
    expect(plan.height).toBe(3000)
    expect(plan.truncated).toBe(false)

    const extended = extendPlan(plan, { contentHeight: 6000, maxScrollY: 5000, clientHeight: 1000 })
    expect(extended.height).toBe(6000)
    expect(extended.truncated).toBe(false)
    expect(extended.slices).toHaveLength(6)
    // The original slices are carried over untouched...
    expect(extended.slices.slice(0, 3)).toEqual(plan.slices)
    // ...and the added ones continue in CANVAS space where they left off,
    // not restarting at destY 0 (which would overwrite already-drawn rows).
    expect(extended.slices[3].destY).toBe(3000)
    expect(extended.slices[5].destY).toBe(5000)
  })

  it('returns the plan unchanged when the live measurement shows no growth (including a page that shrank)', () => {
    const plan = planStitch({ contentTop: 0, contentHeight: 3000, clientHeight: 1000, maxScrollY: 2000 })
    expect(extendPlan(plan, { contentHeight: 3000, maxScrollY: 2000, clientHeight: 1000 })).toEqual(plan)
    expect(extendPlan(plan, { contentHeight: 1000, maxScrollY: 0, clientHeight: 1000 })).toEqual(plan)
  })

  it('flags truncated instead of silently reporting complete when the height cap is already exhausted', () => {
    const plan = planStitch({
      contentTop: 0,
      contentHeight: 100_000,
      clientHeight: 1000,
      maxScrollY: 99_000,
      maxHeight: 5000,
      maxSlices: 50,
    })
    expect(plan.height).toBe(5000)
    expect(plan.truncated).toBe(true)

    // The live page is even taller still — nothing more CAN be added within
    // the same 5000px cap, but this must stay truncated, never silently
    // revert to reporting "complete."
    const extended = extendPlan(plan, {
      contentHeight: 200_000,
      maxScrollY: 199_000,
      clientHeight: 1000,
      maxHeight: 5000,
      maxSlices: 50,
    })
    expect(extended.slices).toEqual(plan.slices)
    expect(extended.truncated).toBe(true)
  })

  it('adds as many slices as the remaining budget allows, then flags truncated when it runs out', () => {
    // 2 slices used already, only 1 more left in a 3-slice budget.
    const plan = planStitch({ contentTop: 0, contentHeight: 2000, clientHeight: 1000, maxScrollY: 1000, maxSlices: 3 })
    expect(plan.slices).toHaveLength(2)
    expect(plan.truncated).toBe(false)

    // The live page grew enough to need 3 more slices, but only 1 is left.
    const extended = extendPlan(plan, { contentHeight: 5000, maxScrollY: 4000, clientHeight: 1000, maxSlices: 3 })
    expect(extended.slices).toHaveLength(3) // 2 original + only 1 more allowed
    expect(extended.truncated).toBe(true)
  })

  it('flags truncated rather than silently reporting complete when the extra pass is degenerate (defensive)', () => {
    const plan = planStitch({ contentTop: 0, contentHeight: 1000, clientHeight: 500, maxScrollY: 500 })
    expect(plan.truncated).toBe(false)

    // An invalid live clientHeight should never happen in practice, but must
    // not silently report "still complete" just because the sub-plan came
    // back empty — we already know more content exists.
    const extended = extendPlan(plan, { contentHeight: 5000, maxScrollY: 4500, clientHeight: 0 })
    expect(extended.slices).toEqual(plan.slices)
    expect(extended.truncated).toBe(true)
  })
})

// Structural guard: capture.ts and marks.ts must funnel through the shared
// throttledCaptureVisibleTab export rather than reintroducing a direct
// chrome.tabs.captureVisibleTab call that bypasses it. Reads the real source
// text (same technique this repo already uses for injected-function tests)
// so a future regression is caught even though the Chrome-quota consequence
// itself isn't practically unit-testable end to end.
describe('capture.ts / marks.ts route through the shared throttle', () => {
  const HERE = fileURLToPath(import.meta.url)
  const DIR = dirname(HERE)

  for (const file of ['capture.ts', 'marks.ts']) {
    it(`${file} imports throttledCaptureVisibleTab and never calls chrome.tabs.captureVisibleTab directly`, () => {
      const source = readFileSync(join(DIR, file), 'utf-8')
      // Drop // line comments first — both files' own header prose mentions
      // "chrome.tabs.captureVisibleTab" in plain English to explain what the
      // shared throttle wraps, which would otherwise false-positive here.
      const code = source
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n')
      expect(source).toMatch(/import\s*\{[^}]*\bthrottledCaptureVisibleTab\b[^}]*\}\s*from\s*['"]\.\/screenshot['"]/)
      expect(code).not.toMatch(/chrome\.tabs\.captureVisibleTab/)
    })
  }
})
