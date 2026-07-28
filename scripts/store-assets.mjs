#!/usr/bin/env node
/**
 * store-assets.mjs — regenerate the Chrome Web Store art in `assets/store/`.
 *
 * The store wants promo tiles at exact pixel sizes with no alpha channel, and
 * an icon whose mark is inset rather than bleeding to the frame edge. Doing
 * that by hand in an image editor is the kind of step that silently rots — the
 * red drifts, the padding changes, and nobody notices until a resubmission is
 * rejected. So the tiles are laid out in HTML against the same tokens the site
 * uses (`site/src/tokens.css`) and shot by headless Chrome at 1:1, and the icon
 * is derived from `assets/logo.png` rather than redrawn.
 *
 * Requires: Google Chrome and ImageMagick (`brew install imagemagick`).
 *
 * Usage: npm run store:assets
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'assets', 'store')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** Brand black. Shared by both tiles and used as the flatten colour. */
const BG = '#0c0709'

const logo = readFileSync(join(ROOT, 'assets', 'logo.png')).toString('base64')

/**
 * One tile template. Every type size is passed in rather than scaled from a
 * single base: the two tiles are viewed at wildly different sizes (a 440px
 * thumbnail in a results grid vs a 1400px feature banner) and each needs its
 * own optical balance, not a proportional shrink of the other.
 *
 * The lockup is centred as a *group* rather than left-aligned against fixed
 * padding — the tagline sets the copy block's width, so fixed padding leaves a
 * ragged gap on one side at one size or the other.
 */
function tile({ w, h, mark, gap, title, tagline, taglineText, rule, glow }) {
  return `<!doctype html>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${w}px; height: ${h}px; overflow: hidden; }
  body {
    background: ${BG};
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex; align-items: center; justify-content: center;
    gap: ${gap}px;
    position: relative;
  }
  /* The glow sits behind the fruit so the mark reads as lit rather than pasted
     onto flat black — the same treatment assets/banner.png uses. */
  .mark-wrap { position: relative; flex: none; width: ${mark}px; height: ${mark}px; }
  .mark-wrap::before {
    content: ''; position: absolute; left: 50%; top: 50%;
    width: ${glow}px; height: ${glow}px; transform: translate(-50%, -50%);
    background: radial-gradient(circle, rgba(201,48,74,0.34) 0%, rgba(201,48,74,0.10) 45%, transparent 70%);
  }
  .mark { position: relative; width: 100%; height: 100%; display: block; }
  .copy { position: relative; }
  h1 { font-size: ${title}px; font-weight: 700; letter-spacing: -0.02em; color: #fff; line-height: 1; }
  p {
    margin-top: ${Math.round(title * 0.28)}px;
    font-size: ${tagline}px; font-weight: 400; line-height: 1.32;
    color: #b9b2b5; letter-spacing: -0.01em;
  }
  .rule {
    position: absolute; left: 0; right: 0; bottom: 0; height: ${rule}px;
    background: linear-gradient(90deg, #c9304a 0%, #f2687e 55%, #c9304a 100%);
  }
</style>
<div class="mark-wrap"><img class="mark" src="data:image/png;base64,${logo}" alt="" /></div>
<div class="copy">
  <h1>Lychee AI</h1>
  <p>${taglineText}</p>
</div>
<div class="rule"></div>
`
}

const TILES = [
  {
    file: 'promo-small-440x280.png',
    w: 440, h: 280, mark: 116, gap: 24,
    title: 40, tagline: 15, rule: 4, glow: 260,
    taglineText: "An AI agent in Chrome's<br />side panel — on your model.",
  },
  {
    file: 'promo-marquee-1400x560.png',
    w: 1400, h: 560, mark: 320, gap: 72,
    title: 112, tagline: 38, rule: 9, glow: 700,
    taglineText: 'Reads, controls, and researches the web<br />with you — with your permission.',
  },
]

const tmp = mkdtempSync(join(tmpdir(), 'lychee-store-'))
mkdirSync(OUT, { recursive: true })

try {
  for (const spec of TILES) {
    const html = join(tmp, `${spec.file}.html`)
    const shot = join(tmp, spec.file)
    writeFileSync(html, tile(spec))
    execFileSync(CHROME, [
      '--headless', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--screenshot=${shot}`,
      `--window-size=${spec.w},${spec.h}`,
      `file://${html}`,
    ], { stdio: 'ignore' })
    // Flatten: the dashboard rejects transparency in promo art, and a shot that
    // merely looks opaque can still carry an alpha channel.
    execFileSync('magick', [shot, '-background', BG, '-alpha', 'remove', '-alpha', 'off', join(OUT, spec.file)])
    console.log(`✓ ${spec.file} (${spec.w}×${spec.h}, opaque)`)
  }

  // Icon: the mark inset to 96×96 inside a 128×128 frame. The bundled toolbar
  // icons in public/icons/ are tuned to stay legible at 16px and bleed closer
  // to the edge; the store icon is shown large, where the inset reads better.
  const src = join(ROOT, 'assets', 'logo.png')
  execFileSync('magick', [src, '-trim', '+repage', '-resize', '96x96',
    '-background', 'none', '-gravity', 'center', '-extent', '128x128',
    join(OUT, 'store-icon-128x128.png')])
  console.log('✓ store-icon-128x128.png (mark inset to 96×96)')

  execFileSync('magick', [src, '-trim', '+repage', '-resize', '512x512',
    '-background', 'none', '-gravity', 'center', '-extent', '512x512',
    join(OUT, 'logo-master-512x512.png')])
  console.log('✓ logo-master-512x512.png (transparent master)')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\nWrote to ${OUT}`)
console.log('Screenshots (1280×800) are NOT generated here — they must be captured')
console.log('from a real session. See "Screenshot Notes" in CHROMEWEBSTORE.md.')
