import { describe, it, expect, vi, beforeEach } from 'vitest'

// Real closeTabs()/listTabFacts() touch chrome.tabs/chrome.storage directly;
// swap only these two out (importOriginal keeps every other export real —
// including planClosure's own module, tabPolicy.ts, which stays untouched)
// so the rest of createAgentTools' dependency graph loads exactly as it does
// in the real extension.
vi.mock('../platform/tabs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/tabs')>()
  return { ...actual, closeTabs: vi.fn() }
})
vi.mock('../platform/tabIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/tabIndex')>()
  return { ...actual, listTabFacts: vi.fn() }
})

import { createAgentTools, type ApprovalGate, type PageControlGate } from './tools'
import { closeTabs } from '../platform/tabs'
import { listTabFacts } from '../platform/tabIndex'
import type { TabFacts } from './tabPolicy'

const fact = (over: Partial<TabFacts> & { tabId: number }): TabFacts & { url: string } => ({
  windowId: 1,
  title: `Tab ${over.tabId}`,
  host: 'example.com',
  url: 'https://example.com/',
  pinned: false,
  active: false,
  groupId: -1,
  ...over,
})

const noopPageControl: PageControlGate = {
  requestSession: async () => false,
  session: () => null,
  endSession: () => {},
}

function buildTools() {
  const requestApproval: ApprovalGate = async () => true
  return createAgentTools(
    requestApproval,
    'all-tabs', // CloseTabs is deleted entirely in 'active-tab' mode
    new Set(),
    noopPageControl,
    null,
    false,
    [],
    () => 'always',
    'conv-1',
    new Set(),
  )
}

describe("CloseTabs — reports the count closeTabs() actually verified, not the pre-approval plan (cross-owner w/ W1-C's tabs.ts)", () => {
  beforeEach(() => {
    vi.mocked(closeTabs).mockReset()
    vi.mocked(listTabFacts).mockReset()
  })

  it('reports result.closed.length even when a planned tab vanished before closeTabs() ran', async () => {
    // Three tabs in one window so planClosure accepts closing two of them
    // without emptying (and so auto-rejecting) the window.
    vi.mocked(listTabFacts).mockResolvedValue([
      fact({ tabId: 1, windowId: 1 }),
      fact({ tabId: 2, windowId: 1 }),
      fact({ tabId: 3, windowId: 1 }),
    ])
    // The plan wants both 1 and 2 closed, but by the time closeTabs() actually
    // ran (past the human-reaction-time approval wait), only one was still
    // there to stash+remove — exactly W1-C's fixed closeTabs() behavior.
    vi.mocked(closeTabs).mockResolvedValue({
      closed: [{ url: 'https://a.test', title: 'A', windowId: 1, index: 0, pinned: false }],
      recoverable: 1,
    })

    const tools = buildTools()
    const result = (await (tools.CloseTabs as any).execute(
      { action: 'close', reason: 'cleanup', tabIds: [1, 2] },
      {} as any,
    )) as { closed: number; error?: string }

    expect(result.error).toBeUndefined()
    // The regression this guards: reporting plan.close.length (2, what was
    // PLANNED) instead of result.closed.length (1, what closeTabs() actually
    // verified) would tell the user "closed 2 tabs" when only 1 really closed
    // — exactly the honesty failure the tab-policy invariant exists to prevent.
    expect(result.closed).toBe(1)
  })

  it('reports the full count when nothing vanished between planning and closing', async () => {
    vi.mocked(listTabFacts).mockResolvedValue([
      fact({ tabId: 1, windowId: 1 }),
      fact({ tabId: 2, windowId: 1 }),
      fact({ tabId: 3, windowId: 1 }),
    ])
    vi.mocked(closeTabs).mockResolvedValue({
      closed: [
        { url: 'https://a.test', title: 'A', windowId: 1, index: 0, pinned: false },
        { url: 'https://b.test', title: 'B', windowId: 1, index: 1, pinned: false },
      ],
      recoverable: 2,
    })

    const tools = buildTools()
    const result = (await (tools.CloseTabs as any).execute(
      { action: 'close', reason: 'cleanup', tabIds: [1, 2] },
      {} as any,
    )) as { closed: number }

    expect(result.closed).toBe(2)
  })
})
