// Chrome Split View: two tabs shown side by side inside one window.
//
// Chrome 140 added `Tab.splitViewId` — both halves of a split carry the same
// id, and a tab outside any split carries SPLIT_VIEW_ID_NONE. Two things in
// this extension were built on the assumption that a window shows exactly one
// tab, and a split breaks both: a chat is bound to a tab id (src/ui/tabChats.ts),
// so focusing the other half looked like switching to an unknown tab and minted
// a fresh chat; and page tools test "is my tab in front?" before acting, so the
// half that did not hold focus read as backgrounded and parked the turn.
//
// This module is the one place that knows what a split is. It is deliberately
// tolerant of not being on Chrome 140+: every helper answers "no split here",
// which collapses each caller to the single-tab behaviour it had before.

/** Chrome's sentinel for "this tab is not in a Split View". */
export const SPLIT_VIEW_ID_NONE = -1

/**
 * A tab as Chrome 140+ reports it.
 *
 * `@types/chrome` predates `splitViewId`, and the manifest's `minimum_chrome_version`
 * is 116 — so the property is both untyped *and* genuinely absent at runtime on
 * a supported browser. Reading it is therefore a cast, and this is the only
 * place allowed to do it: everything else goes through `splitIdOf`.
 */
export interface SplitTabLike {
  id?: number
  windowId?: number
  splitViewId?: number
}

/**
 * The split this tab belongs to, or `undefined` when it is not in one.
 *
 * Collapses all four ways "not in a split" can present — the property is absent
 * (Chrome < 140), it holds the SPLIT_VIEW_ID_NONE sentinel, it is not an
 * integer, or there is no tab at all — so every caller only has to test for
 * `undefined`. Any negative value is rejected rather than just `-1`: the
 * sentinel is the only negative Chrome documents, and a second one appearing
 * later should read as "no split", not as a split whose id is -2.
 */
export function splitIdOf(tab: SplitTabLike | undefined | null): number | undefined {
  const raw = tab?.splitViewId
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return undefined
  return raw
}

/** Are these two tabs the two halves of one split? False if either is in none. */
export function inSameSplit(a: SplitTabLike | undefined | null, b: SplitTabLike | undefined | null): boolean {
  const split = splitIdOf(a)
  return split !== undefined && split === splitIdOf(b)
}

/**
 * Is `tab` one of the tabs its window is currently showing, given that window's
 * active tabs?
 *
 * "Active" stopped being single-valued when split view shipped. Chrome's docs
 * define `active` as "whether the tab is active in its window" and say nothing
 * about splits, and they never state whether `query({active:true})` returns one
 * tab or two when a window is split. So this accepts a tab on either of two
 * independent grounds — it is itself among the active tabs, or it shares a split
 * with one that is — and both readings then give the same answer. If the query
 * returns both halves the first test already passes; if it returns only the
 * focused half, the second catches the other one. That is why this replaced
 * `const [live] = ...; live?.id === tab.id`, which silently picked one of two
 * equally-active tabs and parked the turn whenever it picked the wrong one.
 */
export function isShowing(
  tab: SplitTabLike | undefined | null,
  activeTabs: readonly SplitTabLike[],
): boolean {
  if (tab?.id === undefined) return false
  if (activeTabs.some((t) => t.id === tab.id)) return true
  const split = splitIdOf(tab)
  if (split === undefined) return false
  return activeTabs.some((t) => splitIdOf(t) === split)
}

/**
 * Every tab the given window is showing. Best-effort: a failed query answers
 * "nothing is showing", which makes callers treat their tab as backgrounded —
 * the safe direction, since it parks a turn rather than acting on a page the
 * user cannot see.
 */
export async function activeTabsIn(windowId: number): Promise<chrome.tabs.Tab[]> {
  try {
    return await chrome.tabs.query({ active: true, windowId })
  } catch {
    return []
  }
}

/** `isShowing` against the live window. The check every page tool actually makes. */
export async function isTabShowing(tab: SplitTabLike | undefined | null): Promise<boolean> {
  if (tab?.id === undefined || tab.windowId === undefined) return false
  return isShowing(tab, await activeTabsIn(tab.windowId))
}

/**
 * The other half of this tab's split, or `undefined` when it is not in one.
 *
 * Filters a plain window query rather than using the `splitViewId` query filter:
 * that filter is Chrome 140+ too, and one version dependency (the property,
 * already proven present by `splitIdOf` returning a value) is easier to reason
 * about than two.
 */
export async function splitPartnerOf(
  tab: SplitTabLike | undefined | null,
): Promise<chrome.tabs.Tab | undefined> {
  const split = splitIdOf(tab)
  if (split === undefined || tab?.id === undefined || tab.windowId === undefined) return undefined
  try {
    const tabs = await chrome.tabs.query({ windowId: tab.windowId })
    return tabs.find((t) => t.id !== undefined && t.id !== tab.id && splitIdOf(t) === split)
  } catch {
    return undefined
  }
}

/**
 * Make `tab` the pane a capture will actually shoot, when it is the half of a
 * split that does not currently hold focus. Answers whether it is now safe to
 * capture it.
 *
 * `captureVisibleTab` is documented as returning "the visible area of the
 * currently active tab", and Chrome does not say which half of a split that is
 * — or whether both halves qualify. Guessing has a silent failure mode: the
 * model would be handed the *other* pane's pixels and never know, which is worse
 * than refusing. So instead of betting on a reading, this removes the ambiguity
 * by focusing the target pane first, after which it is unambiguously the active
 * tab. Within a split that is close to a no-op for the user — both panes stay on
 * screen either way, so nothing is hidden and nothing is navigated.
 *
 * Returns false for a tab that is genuinely backgrounded, which leaves the
 * existing "that tab is not in front" handling to park the turn as before.
 */
export async function focusPaneForCapture(tab: SplitTabLike | undefined | null): Promise<boolean> {
  if (tab?.id === undefined || tab.windowId === undefined) return false
  const active = await activeTabsIn(tab.windowId)
  if (active.some((t) => t.id === tab.id)) return true
  const split = splitIdOf(tab)
  if (split === undefined || !active.some((t) => splitIdOf(t) === split)) return false
  try {
    await chrome.tabs.update(tab.id, { active: true })
    return true
  } catch {
    return false
  }
}
