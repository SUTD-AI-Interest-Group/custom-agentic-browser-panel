import { afterEach, expect, test, vi } from 'vitest'
import {
  SPLIT_VIEW_ID_NONE,
  activeTabsIn,
  inSameSplit,
  isShowing,
  focusPaneForCapture,
  isTabShowing,
  splitIdOf,
  splitPartnerOf,
} from './splitView'

/** Minimal chrome.tabs.query stub returning whatever the test hands it. */
function stubTabs(tabs: unknown[], opts: { fail?: boolean; updateFails?: boolean } = {}) {
  const query = vi.fn(async (info: Record<string, unknown>) => {
    if (opts.fail) throw new Error('tabs unavailable')
    return (tabs as { windowId?: number; active?: boolean }[]).filter(
      (t) =>
        (info.windowId === undefined || t.windowId === info.windowId) &&
        (info.active === undefined || t.active === info.active),
    )
  })
  const update = vi.fn(async () => {
    if (opts.updateFails) throw new Error('cannot activate')
  })
  vi.stubGlobal('chrome', { tabs: { query, update } })
  return { query, update }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// --- splitIdOf -------------------------------------------------------------

test('splitIdOf reads a real split id', () => {
  expect(splitIdOf({ splitViewId: 7 })).toBe(7)
  expect(splitIdOf({ splitViewId: 0 })).toBe(0)
})

test('splitIdOf treats every "not in a split" signal as undefined', () => {
  // Chrome 140+ says so explicitly with the sentinel...
  expect(splitIdOf({ splitViewId: SPLIT_VIEW_ID_NONE })).toBeUndefined()
  // ...Chrome < 140 never sets the property at all...
  expect(splitIdOf({})).toBeUndefined()
  // ...and a missing tab is not in a split either.
  expect(splitIdOf(undefined)).toBeUndefined()
  expect(splitIdOf(null)).toBeUndefined()
})

test('splitIdOf rejects values that are not a usable id', () => {
  expect(splitIdOf({ splitViewId: 1.5 })).toBeUndefined()
  expect(splitIdOf({ splitViewId: -2 })).toBeUndefined()
  expect(splitIdOf({ splitViewId: NaN })).toBeUndefined()
  expect(splitIdOf({ splitViewId: '7' } as unknown as { splitViewId?: number })).toBeUndefined()
})

// --- inSameSplit -----------------------------------------------------------

test('inSameSplit pairs the two halves of one split', () => {
  expect(inSameSplit({ splitViewId: 3 }, { splitViewId: 3 })).toBe(true)
  expect(inSameSplit({ splitViewId: 3 }, { splitViewId: 4 })).toBe(false)
})

test('inSameSplit is false when either tab is in no split', () => {
  expect(inSameSplit({ splitViewId: 3 }, { splitViewId: SPLIT_VIEW_ID_NONE })).toBe(false)
  expect(inSameSplit({}, {})).toBe(false)
})

// --- isShowing: the park fix ----------------------------------------------

test('isShowing accepts the plain active tab', () => {
  const tab = { id: 1, splitViewId: SPLIT_VIEW_ID_NONE }
  expect(isShowing(tab, [{ id: 1 }])).toBe(true)
  expect(isShowing(tab, [{ id: 2 }])).toBe(false)
})

test('isShowing accepts a split half when the query returns BOTH halves', () => {
  // The reading where Chrome reports two active tabs: the bound tab is second,
  // which is exactly what `const [live] = ...` used to get wrong.
  const right = { id: 2, splitViewId: 9 }
  expect(isShowing(right, [{ id: 1, splitViewId: 9 }, { id: 2, splitViewId: 9 }])).toBe(true)
})

test('isShowing accepts a split half when the query returns ONLY the focused half', () => {
  // The other reading: Chrome reports one active tab, and the bound tab is the
  // half that does not currently hold focus. It is still on screen.
  const right = { id: 2, splitViewId: 9 }
  expect(isShowing(right, [{ id: 1, splitViewId: 9 }])).toBe(true)
})

test('isShowing still rejects a genuinely backgrounded tab in a split window', () => {
  const buried = { id: 3, splitViewId: SPLIT_VIEW_ID_NONE }
  expect(isShowing(buried, [{ id: 1, splitViewId: 9 }, { id: 2, splitViewId: 9 }])).toBe(false)
})

test('isShowing rejects a tab from some OTHER split that is not on screen', () => {
  const other = { id: 5, splitViewId: 4 }
  expect(isShowing(other, [{ id: 1, splitViewId: 9 }])).toBe(false)
})

test('isShowing needs an id to match on', () => {
  expect(isShowing({ splitViewId: 9 }, [{ id: 1, splitViewId: 9 }])).toBe(false)
  expect(isShowing(undefined, [{ id: 1 }])).toBe(false)
})

test('isShowing is false when nothing is active', () => {
  expect(isShowing({ id: 1 }, [])).toBe(false)
})

// --- chrome shells ---------------------------------------------------------

test('activeTabsIn returns every active tab in the window', async () => {
  stubTabs([
    { id: 1, windowId: 10, active: true, splitViewId: 9 },
    { id: 2, windowId: 10, active: true, splitViewId: 9 },
    { id: 3, windowId: 10, active: false },
    { id: 4, windowId: 11, active: true },
  ])
  expect((await activeTabsIn(10)).map((t) => t.id)).toEqual([1, 2])
})

test('activeTabsIn degrades to empty rather than throwing', async () => {
  stubTabs([], { fail: true })
  expect(await activeTabsIn(10)).toEqual([])
})

test('isTabShowing resolves a split half against the live window', async () => {
  stubTabs([
    { id: 1, windowId: 10, active: true, splitViewId: 9 },
    { id: 2, windowId: 10, active: false, splitViewId: 9 },
  ])
  // id 2 is not itself flagged active, but it shares the split with id 1.
  expect(await isTabShowing({ id: 2, windowId: 10, splitViewId: 9 })).toBe(true)
  expect(await isTabShowing({ id: 3, windowId: 10 })).toBe(false)
})

test('isTabShowing needs both a tab id and a window id', async () => {
  stubTabs([{ id: 1, windowId: 10, active: true }])
  expect(await isTabShowing({ windowId: 10 })).toBe(false)
  expect(await isTabShowing({ id: 1 })).toBe(false)
  expect(await isTabShowing(undefined)).toBe(false)
})

test('splitPartnerOf finds the other half, never the tab itself', async () => {
  stubTabs([
    { id: 1, windowId: 10, splitViewId: 9 },
    { id: 2, windowId: 10, splitViewId: 9 },
    { id: 3, windowId: 10, splitViewId: SPLIT_VIEW_ID_NONE },
  ])
  expect((await splitPartnerOf({ id: 1, windowId: 10, splitViewId: 9 }))?.id).toBe(2)
  expect((await splitPartnerOf({ id: 2, windowId: 10, splitViewId: 9 }))?.id).toBe(1)
})

test('splitPartnerOf is undefined for a tab in no split', async () => {
  stubTabs([{ id: 3, windowId: 10, splitViewId: SPLIT_VIEW_ID_NONE }])
  expect(await splitPartnerOf({ id: 3, windowId: 10, splitViewId: SPLIT_VIEW_ID_NONE })).toBeUndefined()
  // Chrome < 140: no property, so no partner, so every caller falls back to today.
  expect(await splitPartnerOf({ id: 3, windowId: 10 })).toBeUndefined()
})

test('splitPartnerOf degrades to undefined rather than throwing', async () => {
  stubTabs([], { fail: true })
  expect(await splitPartnerOf({ id: 1, windowId: 10, splitViewId: 9 })).toBeUndefined()
})

// --- focusPaneForCapture ---------------------------------------------------

test('focusPaneForCapture leaves an already-focused tab alone', async () => {
  const { update } = stubTabs([{ id: 1, windowId: 10, active: true }])
  expect(await focusPaneForCapture({ id: 1, windowId: 10 })).toBe(true)
  expect(update).not.toHaveBeenCalled()
})

test('focusPaneForCapture focuses the unfocused half of a split before capture', async () => {
  const { update } = stubTabs([
    { id: 1, windowId: 10, active: true, splitViewId: 9 },
    { id: 2, windowId: 10, active: false, splitViewId: 9 },
  ])
  expect(await focusPaneForCapture({ id: 2, windowId: 10, splitViewId: 9 })).toBe(true)
  expect(update).toHaveBeenCalledWith(2, { active: true })
})

test('focusPaneForCapture refuses a genuinely backgrounded tab', async () => {
  const { update } = stubTabs([
    { id: 1, windowId: 10, active: true, splitViewId: 9 },
    { id: 3, windowId: 10, active: false, splitViewId: SPLIT_VIEW_ID_NONE },
  ])
  expect(await focusPaneForCapture({ id: 3, windowId: 10 })).toBe(false)
  expect(update).not.toHaveBeenCalled()
})

test('focusPaneForCapture reports failure rather than throwing', async () => {
  stubTabs(
    [
      { id: 1, windowId: 10, active: true, splitViewId: 9 },
      { id: 2, windowId: 10, active: false, splitViewId: 9 },
    ],
    { updateFails: true },
  )
  expect(await focusPaneForCapture({ id: 2, windowId: 10, splitViewId: 9 })).toBe(false)
})
