// Thin Chrome shell over tab grouping. All of the judgement lives in the pure
// planGrouping (src/tools/tabPolicy.ts); by the time anything here runs, the
// groups are already known to be legal, single-window, and at least two tabs.
//
// Each group is created and titled independently: one window failing (it closed
// while the user was reading the approval card) must not cost the user the other
// four groups, so failures are collected per group rather than thrown.

import type { PlannedGroup } from '../tools/tabPolicy'

export interface CreatedGroup {
  name: string
  color: string
  windowId: number
  tabIds: number[]
  groupId: number
}

export interface GroupingOutcome {
  created: CreatedGroup[]
  failed: { name: string; windowId: number; error: string }[]
}

/** Create each planned group and give it its name and color. */
export async function applyGrouping(groups: PlannedGroup[]): Promise<GroupingOutcome> {
  const created: CreatedGroup[] = []
  const failed: { name: string; windowId: number; error: string }[] = []

  for (const g of groups) {
    try {
      const groupId = await chrome.tabs.group({
        tabIds: g.tabIds,
        createProperties: { windowId: g.windowId },
      })
      // Title/color is a separate call; a group that exists but stayed grey is
      // still better than no group, so this failing does not fail the group.
      // try/catch rather than .catch() — without the tabGroups permission
      // `chrome.tabGroups` is undefined, which throws synchronously and would
      // otherwise escape to the outer catch and report a created group as failed.
      try {
        await chrome.tabGroups.update(groupId, { title: g.name, color: g.color })
      } catch {
        // Group exists but is unnamed; reported as created, which it is.
      }
      created.push({ name: g.name, color: g.color, windowId: g.windowId, tabIds: g.tabIds, groupId })
    } catch (err) {
      failed.push({
        name: g.name,
        windowId: g.windowId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { created, failed }
}

/** Pull tabs out of whatever group they are in, leaving the tabs themselves open. */
export async function ungroupTabs(tabIds: number[]): Promise<{ ungrouped: number[]; error?: string }> {
  if (tabIds.length === 0) return { ungrouped: [] }
  try {
    await chrome.tabs.ungroup(tabIds)
    return { ungrouped: tabIds }
  } catch (err) {
    return { ungrouped: [], error: err instanceof Error ? err.message : String(err) }
  }
}
