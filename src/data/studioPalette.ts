/** OKLCH pairing with constant-hue chroma reduction into sRGB.
 * References: https://www.w3.org/TR/css-color-4/#ok-lab
 * https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
 * Harmony (opposing hues) is a design choice; luminance contrast is measured.
 */
export interface StudioPalette {
  hue: number
  saturation: number
  dark: boolean
  textHueOffset?: number
  textSaturation?: number
}
type RGB = [number, number, number]
const clamp = (n: number, max = 1) => Math.min(max, Math.max(0, n))
export const wrapHue = (h: number) => ((h % 360) + 360) % 360
function linearRgb(l: number, c: number, h: number): RGB {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const x = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const y = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const z = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z,
    -1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z,
    -0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z,
  ]
}
export function oklchRgb(l: number, c: number, h: number): RGB {
  let lo = 0,
    hi = c
  const inGamut = (rgb: RGB) =>
    rgb.every((v) => v >= -0.000001 && v <= 1.000001)
  if (!inGamut(linearRgb(l, c, h))) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(linearRgb(l, mid, h))) lo = mid
      else hi = mid
    }
    c = lo
  }
  return linearRgb(l, c, h).map((v) => {
    v = clamp(v)
    return Math.round(
      255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055),
    )
  }) as RGB
}
export function contrastRatio(a: RGB, b: RGB): number {
  const luminance = (rgb: RGB) => {
    const linear = rgb.map((v) => {
      v /= 255
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  }
  const x = luminance(a),
    y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const hex = (rgb: RGB) =>
  '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')
export function pairedPalette(palette: StudioPalette) {
  const hue = wrapHue(palette.hue)
  const saturation = clamp(palette.saturation, 100)
  const textHue = wrapHue(hue + (palette.textHueOffset ?? 180))
  const textSaturation = clamp(palette.textSaturation ?? saturation * 0.65, 100)
  const background = oklchRgb(
    palette.dark ? 0.23 : 0.94,
    saturation * 0.0012,
    hue,
  )
  let text = oklchRgb(
    palette.dark ? 0.86 : 0.4,
    textSaturation * 0.0018,
    textHue,
  )
  // Search toward the appropriate luminance extreme. Test quantized sRGB, the
  // actual CSS output, rather than assuming OKLCH L equals WCAG luminance.
  for (let i = 1; contrastRatio(background, text) < 7 && i <= 100; i++) {
    const l = palette.dark ? 0.86 + (0.14 * i) / 100 : 0.4 * (1 - i / 100)
    text = oklchRgb(l, textSaturation * 0.0018, textHue)
  }
  return {
    background: hex(background),
    foreground: hex(text),
    contrast: contrastRatio(background, text),
    textHue,
    textSaturation,
  }
}
