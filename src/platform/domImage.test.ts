import { describe, it, expect } from 'vitest'
import { isZeroAlphaColor } from './domImage'

// LOW (d04 F10): opaqueBackground()'s transparency check used to only
// recognize exactly `rgba?(0, 0, 0, 0)` — pure-black zero-alpha. A computed
// background-color of e.g. `rgba(255, 255, 255, 0)` (fully transparent
// white) or any other zero-alpha, non-black color would pass as "opaque" and
// get used as the canvas fill style, but painting with an alpha-0 fill style
// paints nothing — so the PNG this function exists to guarantee opaque could
// still come out transparent. Fix: parse the alpha channel numerically
// instead of pattern-matching black specifically.
describe('isZeroAlphaColor', () => {
  it('recognizes zero-alpha black (the previously-covered case)', () => {
    expect(isZeroAlphaColor('rgba(0, 0, 0, 0)')).toBe(true)
    expect(isZeroAlphaColor('rgb(0, 0, 0, 0)')).toBe(true)
  })

  it('recognizes zero-alpha for ANY color, not just black', () => {
    expect(isZeroAlphaColor('rgba(255, 255, 255, 0)')).toBe(true)
    expect(isZeroAlphaColor('rgba(12, 200, 45, 0)')).toBe(true)
  })

  it('treats a fractional non-zero alpha as NOT transparent', () => {
    expect(isZeroAlphaColor('rgba(255, 255, 255, 0.5)')).toBe(false)
    expect(isZeroAlphaColor('rgba(0, 0, 0, 0.01)')).toBe(false)
  })

  it('treats a plain rgb() with no alpha channel as opaque', () => {
    expect(isZeroAlphaColor('rgb(255, 255, 255)')).toBe(false)
    expect(isZeroAlphaColor('rgb(0, 0, 0)')).toBe(false)
  })

  it('treats a fully-opaque rgba() (alpha 1) as opaque', () => {
    expect(isZeroAlphaColor('rgba(10, 20, 30, 1)')).toBe(false)
  })

  it('does not choke on non-color strings', () => {
    expect(isZeroAlphaColor('transparent')).toBe(false)
    expect(isZeroAlphaColor('')).toBe(false)
    expect(isZeroAlphaColor('#ffffff')).toBe(false)
  })
})
