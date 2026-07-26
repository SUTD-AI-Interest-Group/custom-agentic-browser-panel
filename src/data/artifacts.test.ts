import { describe, expect, it } from 'vitest'
import { planPrune } from './artifacts'

function row(id: string, bytes: number, updatedAt: number) {
  return { id, bytes, updatedAt }
}

describe('planPrune', () => {
  it('evicts nothing under the cap', () => {
    expect(planPrune([row('a', 100, 1), row('b', 100, 2)], 1000)).toEqual([])
  })

  it('evicts oldest-updated first until under the cap', () => {
    const rows = [row('new', 400, 30), row('old', 400, 10), row('mid', 400, 20)]
    expect(planPrune(rows, 900)).toEqual(['old'])
    expect(planPrune(rows, 500)).toEqual(['old', 'mid'])
  })

  it('keeps a single over-cap newest row only when nothing else can go', () => {
    // One huge artifact alone: evicting it would leave nothing — it stays.
    expect(planPrune([row('only', 5000, 1)], 1000)).toEqual([])
    // But with a newer sibling, the older huge one goes.
    expect(planPrune([row('huge-old', 5000, 1), row('small-new', 10, 2)], 1000)).toEqual(['huge-old'])
  })
})
