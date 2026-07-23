// Agent-facing capture engine: the viewport, one element, or the whole page.
//
// Everything is built on chrome.tabs.captureVisibleTab, which only ever returns
// the VISIBLE VIEWPORT of the ACTIVE tab. Anything taller is scroll-and-stitch:
// scroll, shoot, scroll, shoot, and compose the slices onto a canvas. Chrome
// rate-limits captureVisibleTab to roughly 2/sec and silently rejects past that,
// so captures are throttled.
//
// The scroll/crop arithmetic lives in `planStitch`/`planTiles` — pure functions
// over numbers, unit-tested without Chrome. The Chrome/canvas code below is a
// thin shell that executes their plan. The overlap crop (the last slice can't
// scroll far enough, so it re-shows pixels the previous slice already covered)
// is exactly the kind of off-by-one that rots silently, which is why it is
// pure and tested rather than inlined here.

import { setPresenceHidden } from './presence'

/** A finished capture: a PNG data URL and its pixel size. */
export interface Shot {
  dataUrl: string
  width: number
  height: number
}

/** What was captured, for the tool result + the stored artifact's caption. */
export interface ShotMeta {
  url: string
  title: string
  /** Human label for the target, e.g. `<figure> "Q3 revenue chart"` or `the full page`. */
  label: string
  /** Set when the capture was cut short (page taller than the cap). */
  truncated?: boolean
}

// Longest side of any single image handed to a vision model. Most models
// downscale past ~1500px anyway, so exceeding this buys nothing and costs tokens.
const MAX_SIDE = 1400
// Ceiling on how much page we will stitch, in CSS px. Past this we truncate and
// say so, rather than spending a minute of captures on an infinite-scroll feed.
const MAX_FULLPAGE_HEIGHT = 20_000
// Hard cap on capture round-trips for one stitch (each costs ~550ms of throttle
// plus settle time, so this bounds a fullpage shot to a handful of seconds).
const MAX_SLICES = 16
// Chrome throttles captureVisibleTab to ~2/sec; stay under it.
const CAPTURE_INTERVAL_MS = 550
// Let lazily-loaded images and sticky reflow settle after each scroll.
const SETTLE_MS = 350

// ---------------------------------------------------------------------------
// Pure planning — no Chrome, no DOM. See screenshot.test.ts.
// ---------------------------------------------------------------------------

/** One scroll-and-shoot step. All values are CSS px. */
export interface StitchSlice {
  /** Where to scroll the window before shooting. */
  scrollTo: number
  /** Offset INTO the captured viewport to start reading from — the overlap to
   *  skip when the page could not scroll far enough (bottom of the document). */
  srcY: number
  /** How much of the captured viewport to use. */
  srcH: number
  /** Where this slice lands in the stitched output. */
  destY: number
}

export interface StitchPlan {
  slices: StitchSlice[]
  /** Height actually covered — may be less than requested when truncated. */
  height: number
  /** True when the content was taller than the height/slice caps allowed. */
  truncated: boolean
}

export interface StitchGeometry {
  /** Document-space y of the top of the content we want. 0 for a full page. */
  contentTop: number
  /** How tall that content is. The document height for a full page. */
  contentHeight: number
  /** Viewport height. */
  clientHeight: number
  /** The largest window.scrollY the document allows (scrollHeight − clientHeight). */
  maxScrollY: number
  maxHeight?: number
  maxSlices?: number
}

/**
 * Plan the scroll-and-shoot steps that cover `contentHeight` px starting at
 * `contentTop`, given a viewport of `clientHeight` that cannot scroll past
 * `maxScrollY`.
 *
 * The subtle case is the bottom of the document: we want the viewport top at
 * `contentTop + covered`, but the page refuses to scroll beyond `maxScrollY`.
 * The shot therefore starts higher up the page than we asked for, re-showing
 * pixels the previous slice already captured — so we skip that overlap by
 * reading from `srcY` into the captured image instead of from 0.
 *
 * Handles both targets: a full page is `contentTop: 0, contentHeight: scrollHeight`;
 * a tall element is its own document-space box.
 */
export function planStitch(geom: StitchGeometry): StitchPlan {
  const { contentTop, contentHeight, clientHeight, maxScrollY } = geom
  const maxHeight = geom.maxHeight ?? MAX_FULLPAGE_HEIGHT
  const maxSlices = geom.maxSlices ?? MAX_SLICES
  // A zero/negative viewport would loop forever; there is nothing to shoot.
  if (clientHeight <= 0 || contentHeight <= 0) {
    return { slices: [], height: 0, truncated: false }
  }

  const wanted = Math.min(contentHeight, maxHeight)
  const slices: StitchSlice[] = []
  let covered = 0

  while (covered < wanted && slices.length < maxSlices) {
    // The document y we want sitting at the top of the viewport...
    const wantTop = contentTop + covered
    // ...but the page will not scroll past its own bottom.
    const scrollTo = Math.max(0, Math.min(wantTop, maxScrollY))
    // Whatever the clamp cost us is overlap we must skip inside the shot.
    const srcY = wantTop - scrollTo
    const srcH = Math.min(clientHeight - srcY, wanted - covered)
    if (srcH <= 0) break
    slices.push({ scrollTo, srcY, srcH, destY: covered })
    covered += srcH
  }

  return {
    slices,
    height: covered,
    // Either the height cap bit, or we ran out of slices before covering it.
    truncated: contentHeight > wanted || covered < wanted,
  }
}

/** One horizontal band of a stitched image, handed to the model as its own image. */
export interface Tile {
  y: number
  h: number
}

export interface TilePlan {
  tiles: Tile[]
  /** Tiles that did not fit the per-call budget and were dropped from the tail. */
  dropped: number
}

/**
 * Split a tall stitched image into model-sized tiles.
 *
 * A 1200x6000 page squashed into one 1400px-max image is an illegible smear —
 * which defeats the whole point on exactly the pages where seeing matters. So
 * the model gets sequential full-resolution bands instead, each captioned with
 * its position. Tiles past `maxTiles` are dropped from the tail and reported,
 * never silently discarded.
 */
export function planTiles(totalHeight: number, tileHeight: number, maxTiles: number): TilePlan {
  if (totalHeight <= 0 || tileHeight <= 0) return { tiles: [], dropped: 0 }
  const tiles: Tile[] = []
  for (let y = 0; y < totalHeight; y += tileHeight) {
    tiles.push({ y, h: Math.min(tileHeight, totalHeight - y) })
  }
  if (tiles.length <= maxTiles) return { tiles, dropped: 0 }
  return { tiles: tiles.slice(0, maxTiles), dropped: tiles.length - maxTiles }
}

/**
 * How a just-captured shot reaches the model, decided BEFORE tiling.
 *
 * `send`   — vision-capable with per-turn image budget left: tile up to `maxTiles`.
 * `blind`  — the model cannot read images: capture is saved for the USER only.
 * `budget` — vision-capable but this turn's image budget is spent: saved, not sent.
 *
 * `blind` and `budget` both send nothing, but they are distinct on purpose: each
 * needs its own model-facing note, or a text-only model sits and retries for an
 * image it will never be handed.
 */
export type ShotDelivery =
  | { kind: 'send'; maxTiles: number }
  | { kind: 'blind' }
  | { kind: 'budget' }

/** Pure delivery decision. Locks the "text-only still captures" invariant. */
export function planShotDelivery(
  visionCapable: boolean,
  imagesUsed: number,
  maxImages: number,
): ShotDelivery {
  if (!visionCapable) return { kind: 'blind' }
  const budget = Math.max(0, maxImages - imagesUsed)
  if (budget === 0) return { kind: 'budget' }
  return { kind: 'send', maxTiles: budget }
}

// ---------------------------------------------------------------------------
// Capture (side-panel side: has DOM + canvas)
// ---------------------------------------------------------------------------

/** Target of a capture: the viewport, one region/selector, or the whole page. */
export interface ShotTarget {
  kind: 'viewport' | 'element' | 'fullpage'
  /** [rN] from ReadPage(mode:"regions"). */
  region?: number
  /** CSS selector escape hatch. */
  selector?: string
}

export class ShotError extends Error {}

let lastCaptureAt = 0

/** Space out captureVisibleTab calls — Chrome rejects more than ~2/sec. */
async function throttle(): Promise<void> {
  const wait = CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt)
  if (wait > 0) await sleep(wait)
  lastCaptureAt = Date.now()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function exec<A extends unknown[], R>(tabId: number, func: (...args: A) => R, args: A) {
  return chrome.scripting
    .executeScript({ target: { tabId }, func: func as (...a: unknown[]) => unknown, args })
    .then((r) => r[0]?.result as R)
}

async function shoot(windowId: number): Promise<HTMLImageElement> {
  await throttle()
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
  return await loadImage(dataUrl)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new ShotError('Failed to decode the screenshot.'))
    img.src = src
  })
}

/** Downscale a canvas so its longest side fits MAX_SIDE. No-op when it already does. */
function fit(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const scale = Math.min(1, MAX_SIDE / Math.max(canvas.width, canvas.height))
  if (scale === 1) return canvas
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(canvas.width * scale))
  out.height = Math.max(1, Math.round(canvas.height * scale))
  const ctx = out.getContext('2d')
  if (!ctx) throw new ShotError('Canvas is unavailable.')
  ctx.drawImage(canvas, 0, 0, out.width, out.height)
  return out
}

const toShot = (canvas: HTMLCanvasElement): Shot => ({
  dataUrl: canvas.toDataURL('image/png'),
  width: canvas.width,
  height: canvas.height,
})

/**
 * Cut a FULL-RESOLUTION stitched image into model-sized tiles. `shot` must be
 * the un-downscaled canvas (see `capture()`'s `shot` vs `artifact` split) — this
 * is the one place a tall page's vertical detail survives to the model instead
 * of being squashed into one illegible strip.
 *
 * A short shot that already fits both dimensions short-circuits to the whole
 * image, so a plain viewport shot never pays for a needless canvas copy. Once a
 * crop is unavoidable (multiple bands, or a single band still too wide), each
 * resulting tile is `fit()` down only if IT is still oversized — height stays
 * full-res (that's the point), width gets capped for very wide pages.
 */
export async function tileShot(shot: Shot, maxTiles: number): Promise<{ tiles: Shot[]; dropped: number }> {
  const plan = planTiles(shot.height, MAX_SIDE, maxTiles)
  if (plan.tiles.length <= 1 && Math.max(shot.width, shot.height) <= MAX_SIDE) {
    return { tiles: [shot], dropped: plan.dropped }
  }

  const img = await loadImage(shot.dataUrl)
  const cropTile = (y: number, h: number): Shot => {
    const c = document.createElement('canvas')
    c.width = shot.width
    c.height = h
    const ctx = c.getContext('2d')
    if (!ctx) throw new ShotError('Canvas is unavailable.')
    ctx.drawImage(img, 0, y, shot.width, h, 0, 0, shot.width, h)
    return toShot(fit(c))
  }

  if (plan.tiles.length <= 1) return { tiles: [cropTile(0, shot.height)], dropped: plan.dropped }
  const tiles = plan.tiles.map((t) => cropTile(t.y, t.h))
  return { tiles, dropped: plan.dropped }
}

/**
 * Capture `target` from `tab`. The tab must be the active tab of its window —
 * captureVisibleTab has no way to shoot a background tab.
 *
 * The presence overlay is hidden for the duration (its tint would otherwise
 * pollute every pixel the model sees) and always restored, as are the page's
 * scroll position and any position:fixed elements we hid to stop headers
 * duplicating into every slice.
 *
 * Returns TWO images of the same capture: `shot` is the full-resolution
 * stitched canvas — the source `tileShot` slices into full-res bands for the
 * model — and `artifact` is `fit()`-downscaled, for the small strip saved as
 * the user-facing shot. Squashing a tall page down to MAX_SIDE before tiling
 * would make every tile identically illegible, which is the bug this split
 * exists to avoid. For a short viewport shot `fit()` is a no-op, so the two
 * are equal.
 */
export async function capture(
  tab: chrome.tabs.Tab,
  target: ShotTarget,
): Promise<{ shot: Shot; artifact: Shot; meta: ShotMeta }> {
  const tabId = tab.id
  const windowId = tab.windowId
  if (tabId === undefined || windowId === undefined) throw new ShotError('No active tab to capture.')

  // captureVisibleTab shoots whatever is frontmost in the window, so a tab that
  // is no longer active would silently yield someone else's page.
  const [live] = await chrome.tabs.query({ active: true, windowId })
  if (live?.id !== tabId) {
    throw new ShotError('That tab is no longer the active tab, so it cannot be captured.')
  }

  await setPresenceHidden(tabId, true).catch(() => {})
  let restore: (() => Promise<void>) | null = null
  try {
    const prep = await exec(tabId, injPrepare, [])
    if (!prep) throw new ShotError('Cannot script this page (it may be a chrome:// or Web Store page).')
    restore = async () => {
      await exec(tabId, injRestore, [prep.scrollX, prep.scrollY, PRESENCE_ID, HIDDEN_ATTR]).catch(() => {})
    }

    if (target.kind === 'element') return await captureElement(tabId, windowId, tab, target, prep)
    if (target.kind === 'fullpage') return await captureFullPage(tabId, windowId, tab, prep)
    return await captureViewport(windowId, tab, prep)
  } finally {
    // A page left scrolled to the bottom with its header invisible is a visible,
    // user-facing bug — restore before anything else can throw.
    if (restore) await restore()
    await setPresenceHidden(tabId, false).catch(() => {})
  }
}

interface Prep {
  scrollX: number
  scrollY: number
  scrollHeight: number
  clientHeight: number
  clientWidth: number
  dpr: number
  url: string
  title: string
}

async function captureViewport(
  windowId: number,
  tab: chrome.tabs.Tab,
  prep: Prep,
): Promise<{ shot: Shot; artifact: Shot; meta: ShotMeta }> {
  const img = await shoot(windowId)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new ShotError('Canvas is unavailable.')
  ctx.drawImage(img, 0, 0)
  return {
    // Untouched capture for the model to tile; fit() is a no-op here for the
    // common case (viewport already within MAX_SIDE), so the two are equal.
    shot: toShot(canvas),
    artifact: toShot(fit(canvas)),
    meta: { url: prep.url || tab.url || '', title: prep.title || tab.title || '', label: 'the visible viewport' },
  }
}

async function captureFullPage(
  tabId: number,
  windowId: number,
  tab: chrome.tabs.Tab,
  prep: Prep,
): Promise<{ shot: Shot; artifact: Shot; meta: ShotMeta }> {
  const plan = planStitch({
    contentTop: 0,
    contentHeight: prep.scrollHeight,
    clientHeight: prep.clientHeight,
    maxScrollY: Math.max(0, prep.scrollHeight - prep.clientHeight),
  })
  if (plan.slices.length === 0) throw new ShotError('The page has no visible content to capture.')

  const canvas = await stitch(tabId, windowId, plan, prep, null)
  const meta: ShotMeta = {
    url: prep.url || tab.url || '',
    title: prep.title || tab.title || '',
    label: 'the full page',
    truncated: plan.truncated,
  }
  // The full-resolution stitched canvas is the tiling source for the model;
  // the fit()-downscaled copy is the small strip saved for the user.
  return { shot: toShot(canvas), artifact: toShot(fit(canvas)), meta }
}

async function captureElement(
  tabId: number,
  windowId: number,
  tab: chrome.tabs.Tab,
  target: ShotTarget,
  prep: Prep,
): Promise<{ shot: Shot; artifact: Shot; meta: ShotMeta }> {
  if (target.region === undefined && !target.selector) {
    throw new ShotError('An element capture needs either a region index or a CSS selector.')
  }

  const found = await exec(tabId, injMarkTarget, [
    SHOT_ATTR,
    REGION_ATTR,
    target.region ?? -1,
    target.selector ?? '',
  ])
  if (!found?.ok) {
    throw new ShotError(
      target.selector
        ? `No element matches the selector "${target.selector}" on this page.`
        : `No region [r${target.region}] on this page — re-read it with ReadPage(mode:"regions"), since the page may have changed.`,
    )
  }

  // Scrolling triggers lazy-load and sticky reflow, so the rect we planned from
  // is stale the moment we move. Scroll first, let it settle, THEN re-read the
  // live rect and build the plan from that.
  await sleep(SETTLE_MS)
  const box = await exec(tabId, injLiveRect, [SHOT_ATTR])
  if (!box?.ok) throw new ShotError('The element disappeared from the page before it could be captured.')
  if (box.width < 2 || box.height < 2) throw new ShotError('That element has no visible area to capture.')

  const plan = planStitch({
    contentTop: box.docTop,
    contentHeight: box.height,
    clientHeight: prep.clientHeight,
    maxScrollY: Math.max(0, box.scrollHeight - prep.clientHeight),
  })
  if (plan.slices.length === 0) throw new ShotError('That element has no visible area to capture.')

  const canvas = await stitch(tabId, windowId, plan, prep, { left: box.left, width: box.width })
  await exec(tabId, injUnmarkTarget, [SHOT_ATTR]).catch(() => {})

  const name = box.name ? ` "${box.name}"` : ''
  return {
    shot: toShot(canvas),
    artifact: toShot(fit(canvas)),
    meta: {
      url: prep.url || tab.url || '',
      title: prep.title || tab.title || '',
      label: `<${box.tag}>${name}`,
      truncated: plan.truncated,
    },
  }
}

/**
 * Execute a stitch plan onto one canvas. `crop` narrows each slice horizontally
 * to an element's box; null takes the full viewport width.
 *
 * Sticky/fixed elements are hidden from the SECOND slice onward: slice 0 should
 * show the real header once, but leaving it visible thereafter stamps it into
 * every slice and the stitched page reads as a hall of mirrors.
 */
async function stitch(
  tabId: number,
  windowId: number,
  plan: StitchPlan,
  prep: Prep,
  crop: { left: number; width: number } | null,
): Promise<HTMLCanvasElement> {
  const dpr = prep.dpr || 1
  const widthCss = crop ? crop.width : prep.clientWidth
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(widthCss * dpr))
  canvas.height = Math.max(1, Math.round(plan.height * dpr))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new ShotError('Canvas is unavailable.')

  for (let i = 0; i < plan.slices.length; i++) {
    const s = plan.slices[i]
    if (i === 1) await exec(tabId, injSetFixedHidden, [true, PRESENCE_ID, HIDDEN_ATTR]).catch(() => {})
    await exec(tabId, injScrollTo, [s.scrollTo])
    await sleep(SETTLE_MS)
    const img = await shoot(windowId)
    ctx.drawImage(
      img,
      Math.round((crop ? crop.left : 0) * dpr),
      Math.round(s.srcY * dpr),
      Math.round(widthCss * dpr),
      Math.round(s.srcH * dpr),
      0,
      Math.round(s.destY * dpr),
      Math.round(widthCss * dpr),
      Math.round(s.srcH * dpr),
    )
  }
  return canvas
}

// ---------------------------------------------------------------------------
// Injected page-world functions.
//
// These run in the page's isolated world via chrome.scripting.executeScript and
// share NO JS state between injections — each must be fully self-contained (no
// closures, no imports), and any state that has to survive from one injection to
// the next lives in the DOM as an attribute. That is why hiding fixed elements
// stashes each one's prior inline visibility on the element itself.
// ---------------------------------------------------------------------------

const SHOT_ATTR = 'data-agent-shot'
const REGION_ATTR = 'data-agent-region'
const HIDDEN_ATTR = 'data-agent-shot-hidden'
/** The presence overlay's root — it is position:fixed, so the fixed-hiding pass
 *  below would grab it and then fight setPresenceHidden over who restores it. */
const PRESENCE_ID = '__agent_presence'

function injPrepare(): {
  scrollX: number
  scrollY: number
  scrollHeight: number
  clientHeight: number
  clientWidth: number
  dpr: number
  url: string
  title: string
} {
  const doc = document.documentElement
  // Smooth scrolling races the capture: we would shoot mid-glide and stitch
  // blurred, misaligned slices. Force instant jumps for the duration.
  doc.style.scrollBehavior = 'auto'
  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scrollHeight: Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0),
    clientHeight: window.innerHeight,
    clientWidth: doc.clientWidth || window.innerWidth,
    dpr: window.devicePixelRatio || 1,
    url: location.href,
    title: document.title,
  }
}

function injScrollTo(y: number): void {
  window.scrollTo(0, y)
}

/** Hide (or restore) every position:fixed/sticky element, skipping our overlay. */
function injSetFixedHidden(hide: boolean, presenceId: string, attr: string): void {
  if (hide) {
    const all = document.querySelectorAll<HTMLElement>('*')
    all.forEach((el) => {
      if (el.id === presenceId || el.closest('#' + presenceId)) return
      const pos = getComputedStyle(el).position
      if (pos !== 'fixed' && pos !== 'sticky') return
      // Stash the prior inline value ON the element — the next injection shares
      // no JS state with this one, so the DOM is the only place to remember.
      el.setAttribute(attr, el.style.visibility || '')
      el.style.visibility = 'hidden'
    })
    return
  }
  document.querySelectorAll<HTMLElement>('[' + attr + ']').forEach((el) => {
    el.style.visibility = el.getAttribute(attr) || ''
    el.removeAttribute(attr)
  })
}

/** Undo everything the capture did to the page. */
function injRestore(scrollX: number, scrollY: number, presenceId: string, attr: string): void {
  document.querySelectorAll<HTMLElement>('[' + attr + ']').forEach((el) => {
    el.style.visibility = el.getAttribute(attr) || ''
    el.removeAttribute(attr)
  })
  window.scrollTo(scrollX, scrollY)
  document.documentElement.style.scrollBehavior = ''
  void presenceId
}

/** Find the capture target (by region stamp or selector), mark it, scroll to it. */
function injMarkTarget(
  shotAttr: string,
  regionAttr: string,
  region: number,
  selector: string,
): { ok: boolean } {
  document.querySelectorAll('[' + shotAttr + ']').forEach((n) => n.removeAttribute(shotAttr))
  let el: Element | null = null
  if (selector) {
    try {
      el = document.querySelector(selector)
    } catch {
      return { ok: false }
    }
  } else {
    el = document.querySelector('[' + regionAttr + '="' + region + '"]')
  }
  if (!el) return { ok: false }
  el.setAttribute(shotAttr, '1')
  el.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' })
  return { ok: true }
}

/** Re-find the marked element and read its LIVE geometry, post-scroll. */
function injLiveRect(shotAttr: string): {
  ok: boolean
  left: number
  width: number
  height: number
  docTop: number
  scrollHeight: number
  tag: string
  name: string
} {
  const el = document.querySelector('[' + shotAttr + ']')
  const empty = {
    ok: false,
    left: 0,
    width: 0,
    height: 0,
    docTop: 0,
    scrollHeight: 0,
    tag: '',
    name: '',
  }
  if (!el) return empty
  const r = el.getBoundingClientRect()
  const doc = document.documentElement
  const label =
    el.getAttribute('aria-label') ||
    (el.querySelector('figcaption, caption') as HTMLElement | null)?.innerText ||
    el.getAttribute('alt') ||
    ''
  return {
    ok: true,
    left: Math.max(0, r.left),
    width: Math.min(r.width, window.innerWidth),
    height: r.height,
    docTop: r.top + window.scrollY,
    scrollHeight: Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0),
    tag: el.tagName.toLowerCase(),
    name: label.trim().slice(0, 80),
  }
}

function injUnmarkTarget(shotAttr: string): void {
  document.querySelectorAll('[' + shotAttr + ']').forEach((n) => n.removeAttribute(shotAttr))
}
