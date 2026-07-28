import { describe, it, expect } from 'vitest'
import { describeRegionHit } from './highlight'

// The regression these lock down: a region highlight used to report success by
// echoing the [rN] the model passed in ("Scrolled to region [r4] and highlighted
// it"). Asked to point at an equation on a page whose equation is a KaTeX <span>
// — not a region at all — the model ringed the nearest <table>, was told it had
// highlighted [r4], and told the user the job was done. A confirmation built
// only from the caller's own input can never contradict the caller.

describe('describeRegionHit', () => {
  const table = {
    tag: 'table',
    name: '',
    text: '0 1 2 3 4 current state 0 10 35 30 41 current input 10 25 -5 11 -41',
    width: 812,
    height: 279,
  }

  it('quotes what was actually ringed, not just the number asked for', () => {
    const msg = describeRegionHit(4, table)
    expect(msg).toContain('[r4]')
    expect(msg).toContain('<table>')
    // The element's own text is the only thing that can tell the model it aimed
    // at the time-step table when it meant the equation below it.
    expect(msg).toContain('current state 0 10 35 30 41')
  })

  it('tells the model to check the hit before reporting done', () => {
    const msg = describeRegionHit(4, table)
    expect(msg).toMatch(/CHECK THAT AGAINST WHAT YOU MEANT/)
    // And names the way out, so a wrong hit is a correctable step rather than a
    // dead end the model argues from.
    expect(msg).toContain('`text`')
  })

  it('includes the caption/heading name when the page gave the region one', () => {
    const msg = describeRegionHit(2, { ...table, name: 'Time step table' })
    expect(msg).toContain('“Time step table”')
  })

  it('says so plainly when the region holds no text at all', () => {
    const msg = describeRegionHit(7, { tag: 'svg', name: '', text: '', width: 400, height: 300 })
    expect(msg).toContain('no text')
    expect(msg).not.toContain('Its text reads')
  })

  it('reports the ringed size, rounded', () => {
    const msg = describeRegionHit(1, { ...table, width: 811.6, height: 279.2 })
    expect(msg).toContain('812x279')
  })
})
