import { describe, it, expect } from 'vitest'
import { planStitch, planTiles } from './screenshot'

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
})
