// Arc/Dia-style region screenshots — the HUMAN picker (the camera button).
// The agent's own screenshotting lives in screenshot.ts + regionIndex.ts; the two
// share one definition of "a component" (SEMANTIC_TAG_SOURCE) so hovering and
// agent targeting snap to the same boxes.
//
// Flow: the camera button injects selectRegionInPage() into the active tab.
// The page tints, the cursor becomes a sniper: hovering auto-snaps to the DOM
// component under the cursor (the snapped area un-tints), click captures it,
// click-hold-drag captures an arbitrary rectangle, Esc cancels. The injected
// function resolves with the chosen viewport rect only after its overlay has
// been removed and the page repainted, so the subsequent
// chrome.tabs.captureVisibleTab() shot is clean. The side panel then crops
// the shot to the rect on a canvas and returns a data URL ready to attach to
// the next user message as an image part.

import { SEMANTIC_TAG_SOURCE } from './regionIndex'

export interface CapturedImage {
  id: string
  /** PNG data URL, already cropped (and downscaled if very large). */
  dataUrl: string
  width: number
  height: number
}

interface SelectedRegion {
  x: number
  y: number
  width: number
  height: number
  dpr: number
}

/**
 * Runs the full capture flow. Resolves null if the user cancels (Esc).
 * Throws when the page cannot be scripted (chrome:// pages, web store, ...).
 */
export async function captureRegion(): Promise<CapturedImage | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id === undefined) throw new Error('No active tab to capture.')

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: selectRegionInPage,
    // Passed in rather than inlined so the human picker and the agent's region
    // index snap to the same definition of "a component" — see regionIndex.ts.
    // (An injected function cannot close over an import, so it travels as an arg.)
    args: [SEMANTIC_TAG_SOURCE],
  })
  const region = (injection?.result ?? null) as SelectedRegion | null
  if (!region) return null

  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  return cropShot(shot, region)
}

// Keep attachments a sane size for vision APIs; most models downscale beyond
// ~1500px anyway.
const MAX_SIDE = 1400

async function cropShot(shotDataUrl: string, region: SelectedRegion): Promise<CapturedImage> {
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Failed to decode screenshot.'))
    img.src = shotDataUrl
  })

  // The region is in CSS pixels; the shot is in device pixels. Chrome folds
  // page zoom into devicePixelRatio, so this one factor covers both.
  const scale = region.dpr || 1
  const sx = Math.max(0, Math.round(region.x * scale))
  const sy = Math.max(0, Math.round(region.y * scale))
  const sw = Math.min(img.naturalWidth - sx, Math.round(region.width * scale))
  const sh = Math.min(img.naturalHeight - sy, Math.round(region.height * scale))
  if (sw < 4 || sh < 4) throw new Error('Selected area was empty.')

  const down = Math.min(1, MAX_SIDE / Math.max(sw, sh))
  const outW = Math.max(1, Math.round(sw * down))
  const outH = Math.max(1, Math.round(sh * down))

  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable.')
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH)

  return {
    id: crypto.randomUUID(),
    dataUrl: canvas.toDataURL('image/png'),
    width: outW,
    height: outH,
  }
}

// ---------------------------------------------------------------------------
// Injected into the page. Must be fully self-contained: it is serialized by
// chrome.scripting.executeScript and runs in the page's isolated world.
// ---------------------------------------------------------------------------

function selectRegionInPage(semanticSource: string): Promise<{
  x: number
  y: number
  width: number
  height: number
  dpr: number
} | null> {
  return new Promise((resolve) => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const TINT = 'rgba(20, 22, 30, 0.38)'

    const root = document.createElement('div')
    root.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;user-select:none;'
    // Base tint for when nothing is snapped.
    const tint = document.createElement('div')
    tint.style.cssText = `position:absolute;inset:0;background:${TINT};`
    // Highlight box: the un-tinted "hole". The huge box-shadow re-tints
    // everything around it, so the selected area reads as lit-up.
    const box = document.createElement('div')
    box.style.cssText =
      'position:absolute;display:none;border:1.5px solid #7ab8ff;border-radius:5px;' +
      `box-shadow:0 0 0 99999px ${TINT};pointer-events:none;`
    root.appendChild(tint)
    root.appendChild(box)
    document.documentElement.appendChild(root)

    type Rect = { x: number; y: number; width: number; height: number }
    let hovered: Rect | null = null
    let dragStart: { x: number; y: number } | null = null
    let dragging = false

    const showBox = (r: Rect) => {
      tint.style.display = 'none'
      box.style.display = 'block'
      box.style.left = `${r.x}px`
      box.style.top = `${r.y}px`
      box.style.width = `${r.width}px`
      box.style.height = `${r.height}px`
    }
    const hideBox = () => {
      box.style.display = 'none'
      tint.style.display = 'block'
    }

    const clamp = (r: DOMRect): Rect | null => {
      const x0 = Math.max(0, r.left)
      const y0 = Math.max(0, r.top)
      const x1 = Math.min(vw, r.right)
      const y1 = Math.min(vh, r.bottom)
      if (x1 - x0 < 8 || y1 - y0 < 8) return null
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
    }

    // Auto-snap: find the "component" under the cursor. Prefer the deepest
    // element that is at least icon-sized; then, if a semantic container
    // (section, article, card-like landmark...) sits just above it without
    // being dramatically larger, snap to that instead — this is what makes
    // hovering feel like it lands on designed components rather than
    // arbitrary leaf nodes.
    // Shared with the agent's region index (passed in as `semanticSource`) so both
    // agree on what counts as a component. Matched against an UPPERCASED tagName —
    // SVG elements are XML-cased, so `svg.tagName` is 'svg', not 'SVG'.
    const SEMANTIC = new RegExp(semanticSource)
    const componentAt = (cx: number, cy: number): Rect | null => {
      root.style.pointerEvents = 'none'
      const leaf = document.elementFromPoint(cx, cy)
      root.style.pointerEvents = 'auto'
      if (!leaf || leaf === document.documentElement || leaf === document.body) return null

      const MIN = 40
      const MAX_AREA = vw * vh * 0.92
      let base: { rect: Rect; area: number } | null = null
      let node: Element | null = leaf
      let hopsPastBase = 0
      while (node && node !== document.body && node !== document.documentElement) {
        const raw = node.getBoundingClientRect()
        const r = clamp(raw)
        const area = raw.width * raw.height
        const qualifies = r !== null && raw.width >= MIN && raw.height >= MIN && area <= MAX_AREA
        if (qualifies && !base) {
          base = { rect: r!, area }
        } else if (qualifies && base) {
          hopsPastBase++
          if (SEMANTIC.test(node.tagName.toUpperCase()) && area <= base.area * 3.5) return r
          if (hopsPastBase >= 3 || area > base.area * 3.5) break
        }
        node = node.parentElement
      }
      return base ? base.rect : clamp(leaf.getBoundingClientRect())
    }

    const dragRect = (a: { x: number; y: number }, e: MouseEvent): Rect => ({
      x: Math.max(0, Math.min(a.x, e.clientX)),
      y: Math.max(0, Math.min(a.y, e.clientY)),
      width: Math.min(vw, Math.max(a.x, e.clientX)) - Math.max(0, Math.min(a.x, e.clientX)),
      height: Math.min(vh, Math.max(a.y, e.clientY)) - Math.max(0, Math.min(a.y, e.clientY)),
    })

    const onMove = (e: MouseEvent) => {
      if (dragStart) {
        if (dragging || Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 4) {
          dragging = true
          hovered = dragRect(dragStart, e)
          showBox(hovered)
        }
        return
      }
      hovered = componentAt(e.clientX, e.clientY)
      hovered ? showBox(hovered) : hideBox()
    }
    const onDown = (e: MouseEvent) => {
      e.preventDefault()
      dragStart = { x: e.clientX, y: e.clientY }
    }
    const onUp = (e: MouseEvent) => {
      const rect = dragging && dragStart ? dragRect(dragStart, e) : hovered ?? componentAt(e.clientX, e.clientY)
      finish(rect && rect.width >= 8 && rect.height >= 8 ? rect : null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(null)
      }
    }

    function finish(rect: Rect | null) {
      root.removeEventListener('mousemove', onMove)
      root.removeEventListener('mousedown', onDown)
      root.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKey, true)
      root.remove()
      if (!rect) {
        resolve(null)
        return
      }
      // Two frames so the overlay is gone from the compositor before the
      // side panel calls captureVisibleTab.
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          resolve({ ...rect, dpr: window.devicePixelRatio || 1 }),
        ),
      )
    }

    root.addEventListener('mousemove', onMove)
    root.addEventListener('mousedown', onDown)
    root.addEventListener('mouseup', onUp)
    window.addEventListener('keydown', onKey, true)
  })
}
