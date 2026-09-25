import { describe, expect, it } from 'vitest'
import { isNearBottom, STICK_THRESHOLD_PX } from './scrollStick'

// A 500px-tall viewport over 2000px of transcript: the bottom is scrollTop 1500.
const at = (scrollTop: number) => ({ scrollTop, scrollHeight: 2000, clientHeight: 500 })

describe('isNearBottom', () => {
  it('sticks when parked exactly at the bottom', () => {
    expect(isNearBottom(at(1500))).toBe(true)
  })

  it('sticks within the threshold, so sub-pixel drift keeps following the stream', () => {
    expect(isNearBottom(at(1500 - STICK_THRESHOLD_PX))).toBe(true)
    expect(isNearBottom(at(1499.5))).toBe(true)
  })

  // The regression this module exists for: a user who scrolls up to re-read an
  // earlier message must NOT be dragged back down by the next streamed token.
  it('detaches once the user scrolls past the threshold', () => {
    expect(isNearBottom(at(1500 - STICK_THRESHOLD_PX - 1))).toBe(false)
    expect(isNearBottom(at(0))).toBe(false)
  })

  it('treats a transcript shorter than the viewport as at-the-bottom', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 120, clientHeight: 500 })).toBe(true)
  })

  it('honors an explicit threshold', () => {
    expect(isNearBottom(at(1490), 0)).toBe(false)
    expect(isNearBottom(at(1490), 10)).toBe(true)
  })
})
