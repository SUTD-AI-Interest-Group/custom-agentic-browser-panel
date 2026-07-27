// The legality layer for tab grouping and closing. Pure and Chrome-free so it can
// be exercised exhaustively in vitest — this is the piece that decides what the
// agent may do to a browser window full of the user's work.
//
// Unlike browsePolicy.ts (which substitutes for an absent human), a human IS at
// the gate here: every call raises an approval card. So the job of this file is
// not "refuse anything risky" — it is to make the card HONEST. The model proposes
// a grouping over ids it read moments ago; by the time the user clicks Allow, tabs
// may have moved, closed, or been filed by hand. Everything below rewrites a
// proposal into the subset that is actually performable, and names what it
// dropped, so the card lists exactly what will happen and the model can explain
// the difference rather than silently under-delivering.

/** The minimum a caller must know about a tab to plan against it. Chrome's own
 *  Tab object satisfies this structurally; tests can hand-roll it. */
export interface TabFacts {
  tabId: number
  windowId: number
  title: string
  host: string
  pinned: boolean
  active: boolean
  /** Chrome's TAB_GROUP_ID_NONE (-1) when the tab is not in a group. */
  groupId: number
}

/** Chrome's tab-group palette. A group must be one of these nine. */
export const TAB_GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
] as const

export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number]

export const TAB_GROUP_ID_NONE = -1

/** Longest group name Chrome renders without truncating to uselessness. */
const MAX_GROUP_NAME = 40

/** A group is only worth making at two tabs. One-tab groups are visual noise. */
const MIN_GROUP_SIZE = 2

/** Something the model asked for that will not happen, and why. The reason is
 *  shown to the model (so it can adjust or explain), never swallowed. */
export interface Rejection {
  tabId: number
  reason: string
}

/** What the model proposed: a named bucket of tab ids. */
export interface ProposedGroup {
  name: string
  color?: string
  tabIds: number[]
}

/** One Chrome tab group that will actually be created. Always single-window. */
export interface PlannedGroup {
  name: string
  color: TabGroupColor
  windowId: number
  tabIds: number[]
}

export interface GroupingPlan {
  groups: PlannedGroup[]
  rejected: Rejection[]
}

/** Trim and clamp a model-supplied group name; never returns empty. */
export function clampGroupName(raw: string): string {
  const name = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!name) return 'Group'
  return name.length > MAX_GROUP_NAME ? `${name.slice(0, MAX_GROUP_NAME - 1).trimEnd()}…` : name
}

/**
 * Resolve a model-supplied color to a real Chrome one. A model that invents
 * "teal" or omits the field still gets a group — it falls back to a rotation by
 * position, so a multi-group run comes out visually distinct rather than nine
 * identical grey groups.
 */
export function resolveGroupColor(raw: string | undefined, index: number): TabGroupColor {
  const want = (raw ?? '').trim().toLowerCase()
  const hit = TAB_GROUP_COLORS.find((c) => c === want)
  if (hit) return hit
  // Skip grey in the rotation — it reads as "unset" rather than as a choice.
  return TAB_GROUP_COLORS[1 + (index % (TAB_GROUP_COLORS.length - 1))]
}

/**
 * Rewrite a proposed grouping into the groups that can legally be created.
 *
 * The rules, in the order they are applied per tab:
 *  1. Unknown id — the tab closed or was never real.
 *  2. Already claimed by an earlier group in this same proposal — first wins, so
 *     a tab can never be pulled two ways.
 *  3. Pinned — Chrome cannot put a pinned tab in a group.
 *  4. Already in a group — the user filed this by hand and we do not re-file it.
 *
 * Survivors are then split by window, because chrome.tabs.group cannot span
 * windows and moving tabs between windows is jarring and near-impossible to
 * undo. A proposal whose tabs live in three windows yields three same-named,
 * same-colored groups rather than one group and two disappointments.
 */
export function planGrouping(proposed: ProposedGroup[], tabs: TabFacts[]): GroupingPlan {
  const byId = new Map(tabs.map((t) => [t.tabId, t]))
  const claimed = new Map<number, string>()
  const rejected: Rejection[] = []
  const groups: PlannedGroup[] = []

  proposed.forEach((group, groupIndex) => {
    const name = clampGroupName(group.name)
    const color = resolveGroupColor(group.color, groupIndex)
    // Per-window buckets: one proposed group can become several Chrome groups.
    const byWindow = new Map<number, number[]>()

    for (const tabId of group.tabIds) {
      const tab = byId.get(tabId)
      if (!tab) {
        rejected.push({ tabId, reason: 'No tab with that id is open any more.' })
        continue
      }
      const owner = claimed.get(tabId)
      if (owner !== undefined) {
        rejected.push({ tabId, reason: `Already assigned to the group "${owner}".` })
        continue
      }
      if (tab.pinned) {
        rejected.push({ tabId, reason: 'Pinned tabs cannot be put in a group.' })
        continue
      }
      if (tab.groupId !== TAB_GROUP_ID_NONE) {
        rejected.push({ tabId, reason: 'Already in a tab group the user made; existing groups are left alone.' })
        continue
      }
      claimed.set(tabId, name)
      const bucket = byWindow.get(tab.windowId)
      if (bucket) bucket.push(tabId)
      else byWindow.set(tab.windowId, [tabId])
    }

    for (const [windowId, tabIds] of byWindow) {
      if (tabIds.length < MIN_GROUP_SIZE) {
        // Release the claim so a later proposed group may still use the tab.
        for (const tabId of tabIds) {
          claimed.delete(tabId)
          rejected.push({
            tabId,
            reason: `Only ${tabIds.length} tab of "${name}" is in that window — a group needs at least ${MIN_GROUP_SIZE}.`,
          })
        }
        continue
      }
      groups.push({ name, color, windowId, tabIds })
    }
  })

  return { groups, rejected }
}

export interface ClosurePlan {
  close: number[]
  rejected: Rejection[]
}

/**
 * Rewrite a proposed closure into the tabs that may actually be closed.
 *
 * Refusals:
 *  - the active tab — closing the tab under the user's cursor is never what
 *    "tidy up my tabs" meant;
 *  - pinned tabs — pinning is the user's own "keep this" marker;
 *  - unknown ids — already gone;
 *  - the last surviving tab of a window — Chrome closes the window with it, and
 *    a vanished window is not something an undo stash of URLs can restore.
 */
export function planClosure(tabIds: number[], tabs: TabFacts[]): ClosurePlan {
  const byId = new Map(tabs.map((t) => [t.tabId, t]))
  const totalPerWindow = new Map<number, number>()
  for (const t of tabs) totalPerWindow.set(t.windowId, (totalPerWindow.get(t.windowId) ?? 0) + 1)

  const rejected: Rejection[] = []
  const accepted: number[] = []
  const seen = new Set<number>()

  for (const tabId of tabIds) {
    if (seen.has(tabId)) continue
    seen.add(tabId)
    const tab = byId.get(tabId)
    if (!tab) {
      rejected.push({ tabId, reason: 'No tab with that id is open any more.' })
      continue
    }
    if (tab.active) {
      rejected.push({ tabId, reason: 'This is the tab the user is looking at right now.' })
      continue
    }
    if (tab.pinned) {
      rejected.push({ tabId, reason: 'Pinned tabs are kept — pinning is the user saying "keep this".' })
      continue
    }
    accepted.push(tabId)
  }

  // Emptying a window closes it. Keep the last one back rather than making a
  // window disappear, which no URL stash could bring back intact.
  const acceptedPerWindow = new Map<number, number[]>()
  for (const tabId of accepted) {
    const windowId = byId.get(tabId)!.windowId
    const bucket = acceptedPerWindow.get(windowId)
    if (bucket) bucket.push(tabId)
    else acceptedPerWindow.set(windowId, [tabId])
  }
  const held = new Set<number>()
  for (const [windowId, ids] of acceptedPerWindow) {
    if (ids.length >= (totalPerWindow.get(windowId) ?? 0)) {
      const last = ids[ids.length - 1]
      held.add(last)
      rejected.push({
        tabId: last,
        reason: 'Kept back — closing every tab in a window would close the window itself.',
      })
    }
  }

  return { close: accepted.filter((id) => !held.has(id)), rejected }
}
