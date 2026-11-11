import { expect, it } from 'vitest'
import { contrastRatio, oklchRgb, pairedPalette } from './studioPalette'
it('computes reference sRGB luminance contrast', () => {
  expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBe(21)
  expect(contrastRatio([127, 127, 127], [127, 127, 127])).toBe(1)
  expect(oklchRgb(1, 0, 0)).toEqual([255, 255, 255])
})
it('maintains at least 7:1 for all sampled hues, strengths, text offsets and modes after quantization', () => {
  for (const dark of [false, true])
    for (let hue = 0; hue < 360; hue += 10)
      for (const saturation of [0, 25, 55, 100])
        for (const textHueOffset of [0, 60, 180, 270]) {
          const pair = pairedPalette({
            hue,
            saturation,
            dark,
            textHueOffset,
            textSaturation: 100,
          })
          expect(pair.contrast).toBeGreaterThanOrEqual(7)
          expect(pair.background).toMatch(/^#[0-9a-f]{6}$/)
        }
})
it('auto-pairs opposite hues while preserving a user-selected relative offset', () => {
  expect(pairedPalette({ hue: 270, saturation: 50, dark: false }).textHue).toBe(
    90,
  )
  expect(
    pairedPalette({ hue: 90, saturation: 50, dark: true, textHueOffset: 60 })
      .textHue,
  ).toBe(150)
})
