import { describe, expect, it } from 'vitest'
import { comparePinnedThenRecent, type ConversationSummary } from './conversations'

// Pure comparator only — listConversations/togglePin are IndexedDB-coupled and
// exercised end to end via the browser verification pass instead.

type Row = Pick<ConversationSummary, 'pinned' | 'updatedAt'>

function sortRows(rows: Row[]): Row[] {
  return [...rows].sort(comparePinnedThenRecent)
}

describe('comparePinnedThenRecent', () => {
  it('puts pinned rows before unpinned rows regardless of recency', () => {
    const older = { pinned: true, updatedAt: 1 }
    const newer = { pinned: false, updatedAt: 100 }
    expect(sortRows([newer, older])).toEqual([older, newer])
  })

  it('orders unpinned rows by updatedAt descending', () => {
    const a = { pinned: false, updatedAt: 10 }
    const b = { pinned: false, updatedAt: 30 }
    const c = { pinned: false, updatedAt: 20 }
    expect(sortRows([a, b, c])).toEqual([b, c, a])
  })

  it('orders pinned rows among themselves by updatedAt descending', () => {
    const a = { pinned: true, updatedAt: 5 }
    const b = { pinned: true, updatedAt: 15 }
    expect(sortRows([a, b])).toEqual([b, a])
  })

  it('treats a missing pinned flag as false', () => {
    const untouched: Row = { updatedAt: 50 } as Row
    const pinned = { pinned: true, updatedAt: 1 }
    expect(sortRows([untouched, pinned])).toEqual([pinned, untouched])
  })
})
