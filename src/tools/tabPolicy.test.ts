import { describe, it, expect } from 'vitest'
import {
  clampGroupName,
  planClosure,
  planGrouping,
  resolveGroupColor,
  TAB_GROUP_ID_NONE,
  type TabFacts,
} from './tabPolicy'

/** Minimal TabFacts factory — every field the policy reads, sane defaults. */
function tab(over: Partial<TabFacts> & { tabId: number }): TabFacts {
  return {
    windowId: 1,
    title: `Tab ${over.tabId}`,
    host: 'example.com',
    pinned: false,
    active: false,
    groupId: TAB_GROUP_ID_NONE,
    ...over,
  }
}

describe('clampGroupName', () => {
  it('trims, collapses whitespace, and never returns empty', () => {
    expect(clampGroupName('  Thesis   sources ')).toBe('Thesis sources')
    expect(clampGroupName('')).toBe('Group')
    expect(clampGroupName('   ')).toBe('Group')
  })

  it('clamps an over-long name with an ellipsis', () => {
    const out = clampGroupName('x'.repeat(80))
    expect(out).toHaveLength(40)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('resolveGroupColor', () => {
  it('accepts a valid Chrome color, case-insensitively', () => {
    expect(resolveGroupColor('cyan', 0)).toBe('cyan')
    expect(resolveGroupColor('  Purple ', 3)).toBe('purple')
  })

  it('falls back to a non-grey rotation for invented or missing colors', () => {
    expect(resolveGroupColor('teal', 0)).toBe('blue')
    expect(resolveGroupColor(undefined, 1)).toBe('red')
    // Distinct colors across a multi-group run, and never the "unset-looking" grey.
    const rotated = [0, 1, 2, 3].map((i) => resolveGroupColor('nonsense', i))
    expect(new Set(rotated).size).toBe(4)
    expect(rotated).not.toContain('grey')
  })
})

describe('planGrouping', () => {
  it('creates a group from ungrouped tabs in one window', () => {
    const tabs = [tab({ tabId: 1 }), tab({ tabId: 2 }), tab({ tabId: 3 })]
    const plan = planGrouping([{ name: 'Research', color: 'green', tabIds: [1, 2, 3] }], tabs)
    expect(plan.rejected).toEqual([])
    expect(plan.groups).toEqual([
      { name: 'Research', color: 'green', windowId: 1, tabIds: [1, 2, 3] },
    ])
  })

  it('splits one proposed group across windows rather than moving tabs', () => {
    const tabs = [
      tab({ tabId: 1, windowId: 1 }),
      tab({ tabId: 2, windowId: 1 }),
      tab({ tabId: 3, windowId: 7 }),
      tab({ tabId: 4, windowId: 7 }),
    ]
    const plan = planGrouping([{ name: 'Docs', color: 'blue', tabIds: [1, 2, 3, 4] }], tabs)
    expect(plan.groups).toHaveLength(2)
    expect(plan.groups.map((g) => g.windowId).sort()).toEqual([1, 7])
    // Same identity in both windows, so it still reads as one group to the user.
    expect(plan.groups.every((g) => g.name === 'Docs' && g.color === 'blue')).toBe(true)
    expect(plan.rejected).toEqual([])
  })

  it('never re-files a tab the user already grouped', () => {
    const tabs = [tab({ tabId: 1 }), tab({ tabId: 2 }), tab({ tabId: 3, groupId: 99 })]
    const plan = planGrouping([{ name: 'Mine', tabIds: [1, 2, 3] }], tabs)
    expect(plan.groups[0].tabIds).toEqual([1, 2])
    expect(plan.rejected).toEqual([
      { tabId: 3, reason: expect.stringContaining('Already in a tab group') },
    ])
  })

  it('rejects pinned and unknown tabs', () => {
    const tabs = [tab({ tabId: 1 }), tab({ tabId: 2 }), tab({ tabId: 3, pinned: true })]
    const plan = planGrouping([{ name: 'Mine', tabIds: [1, 2, 3, 404] }], tabs)
    expect(plan.groups[0].tabIds).toEqual([1, 2])
    expect(plan.rejected.map((r) => r.tabId).sort()).toEqual([3, 404])
  })

  it('gives a tab to the first group that claims it', () => {
    const tabs = [tab({ tabId: 1 }), tab({ tabId: 2 }), tab({ tabId: 3 }), tab({ tabId: 4 })]
    const plan = planGrouping(
      [
        { name: 'First', tabIds: [1, 2] },
        { name: 'Second', tabIds: [2, 3, 4] },
      ],
      tabs,
    )
    expect(plan.groups[0].tabIds).toEqual([1, 2])
    expect(plan.groups[1].tabIds).toEqual([3, 4])
    expect(plan.rejected).toEqual([
      { tabId: 2, reason: 'Already assigned to the group "First".' },
    ])
  })

  it('drops a group that would hold fewer than two tabs', () => {
    const tabs = [tab({ tabId: 1 }), tab({ tabId: 2 })]
    const plan = planGrouping([{ name: 'Lonely', tabIds: [1] }], tabs)
    expect(plan.groups).toEqual([])
    expect(plan.rejected[0].reason).toContain('at least 2')
  })

  it('releases a tab dropped as a singleton so a later group can still use it', () => {
    // Tab 3 is alone in window 7 for "Split", so that sub-group dies — but tab 3
    // must not stay claimed, or the following group silently loses it too.
    const tabs = [
      tab({ tabId: 1, windowId: 1 }),
      tab({ tabId: 2, windowId: 1 }),
      tab({ tabId: 3, windowId: 7 }),
      tab({ tabId: 4, windowId: 7 }),
    ]
    const plan = planGrouping(
      [
        { name: 'Split', tabIds: [1, 2, 3] },
        { name: 'Later', tabIds: [3, 4] },
      ],
      tabs,
    )
    expect(plan.groups).toEqual([
      { name: 'Split', color: 'blue', windowId: 1, tabIds: [1, 2] },
      { name: 'Later', color: 'red', windowId: 7, tabIds: [3, 4] },
    ])
  })
})

describe('planClosure', () => {
  it('closes ordinary background tabs', () => {
    const tabs = [tab({ tabId: 1, active: true }), tab({ tabId: 2 }), tab({ tabId: 3 })]
    const plan = planClosure([2, 3], tabs)
    expect(plan.close).toEqual([2, 3])
    expect(plan.rejected).toEqual([])
  })

  it('refuses the active tab, pinned tabs, and unknown ids', () => {
    const tabs = [
      tab({ tabId: 1, active: true }),
      tab({ tabId: 2, pinned: true }),
      tab({ tabId: 3 }),
      tab({ tabId: 4 }),
    ]
    const plan = planClosure([1, 2, 3, 404], tabs)
    expect(plan.close).toEqual([3])
    expect(plan.rejected.map((r) => r.tabId)).toEqual([1, 2, 404])
  })

  it('holds one tab back rather than closing a whole window', () => {
    const tabs = [
      tab({ tabId: 1, windowId: 1, active: true }),
      tab({ tabId: 2, windowId: 7 }),
      tab({ tabId: 3, windowId: 7 }),
    ]
    const plan = planClosure([2, 3], tabs)
    expect(plan.close).toEqual([2])
    expect(plan.rejected).toEqual([
      { tabId: 3, reason: expect.stringContaining('would close the window') },
    ])
  })

  it('closes every requested tab when the window keeps a survivor', () => {
    const tabs = [
      tab({ tabId: 1, windowId: 7, active: true }),
      tab({ tabId: 2, windowId: 7 }),
      tab({ tabId: 3, windowId: 7 }),
    ]
    const plan = planClosure([2, 3], tabs)
    expect(plan.close).toEqual([2, 3])
    expect(plan.rejected).toEqual([])
  })

  it('ignores duplicate ids', () => {
    const tabs = [tab({ tabId: 1, active: true }), tab({ tabId: 2 }), tab({ tabId: 3 })]
    const plan = planClosure([2, 2, 2], tabs)
    expect(plan.close).toEqual([2])
    expect(plan.rejected).toEqual([])
  })
})
