// Set-of-marks: capture a clean screenshot of the tab and draw the registry's
// numbered boxes onto it, so a vision model can pick an element by number. The
// same [index] maps to the same DOM node the text registry uses.

import type { IndexedElement } from './domIndex'
import { throttledCaptureVisibleTab } from './screenshot'

const MAX_SIDE = 1400
// Same string as domIndex.ts's own ATTR — each file keeps its own copy since
// an injected function shares no JS state (not even an imported constant)
// with the module that defines it.
const IDX_ATTR = 'data-agent-idx'

/** Screenshot the tab and overlay numbered boxes for each indexed element. */
export async function captureWithMarks(
  tabId: number,
  windowId: number,
  elements: IndexedElement[],
  dpr: number,
): Promise<string> {
  // Routed through screenshot.ts's shared throttle — capture.ts, marks.ts,
  // and screenshot.ts's own shoot() all draw on Chrome's one ~2/sec quota, so
  // any two of them chained back-to-back (e.g. ReadPage(mode:"elements")
  // immediately followed by GetScreenshot) must share the same clock.
  const shot = await throttledCaptureVisibleTab(windowId)
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Failed to decode screenshot.'))
    img.src = shot
  })

  // `elements[].rect` is a snapshot taken whenever buildInteractiveIndex ran,
  // several awaited round trips before this line (the presence-hide, the tab
  // liveness check, this very capture). Any layout shift in that window — a
  // lazy image finishing, an ad slot resizing, an SPA re-render — leaves the
  // snapshot rects pointing at stale coordinates. Re-read each stamped
  // element's LIVE rect right before drawing, falling back to the snapshot
  // rect only for an index whose element can no longer be found (removed
  // from the page since the snapshot, or the injection failed outright).
  const live = await readLiveRects(tabId, elements.map((el) => el.index))

  const down = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.naturalWidth * down)
  canvas.height = Math.round(img.naturalHeight * down)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  ctx.font = 'bold 12px system-ui'
  for (const el of elements) {
    const rect = live[el.index] ?? el.rect
    const x = rect.x * dpr * down
    const y = rect.y * dpr * down
    const w = rect.width * dpr * down
    const h = rect.height * dpr * down
    ctx.strokeStyle = '#ff3b6b'
    ctx.lineWidth = 1.5
    ctx.strokeRect(x, y, w, h)
    const tag = String(el.index)
    const tw = ctx.measureText(tag).width + 6
    ctx.fillStyle = '#ff3b6b'
    ctx.fillRect(x, Math.max(0, y - 14), tw, 14)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(tag, x + 3, Math.max(10, y - 3))
  }
  return canvas.toDataURL('image/png')
}

type Rect = { x: number; y: number; width: number; height: number }

/**
 * Re-find each element by its data-agent-idx stamp and read its CURRENT
 * viewport rect. Best-effort: an injection failure (tab closed/navigated
 * away between the screenshot and this call) degrades to an empty map, so
 * callers fall back to the snapshot rect for every index rather than the
 * whole capture failing over a re-read that was only ever a freshness bonus.
 */
async function readLiveRects(tabId: number, indices: number[]): Promise<Record<number, Rect | undefined>> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injLiveRects,
      args: [IDX_ATTR, indices],
    })
    return injection?.result ?? {}
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Injected into the page via chrome.scripting.executeScript — runs in the
// page's isolated world, sharing no JS state with this module. Must stay
// fully self-contained: no closures over outer scope, no imports.
// ---------------------------------------------------------------------------

function injLiveRects(attr: string, indices: number[]): Record<number, Rect> {
  const out: Record<number, Rect> = {}
  for (const idx of indices) {
    const el = document.querySelector('[' + attr + '="' + idx + '"]')
    if (!el) continue
    const r = el.getBoundingClientRect()
    out[idx] = { x: r.left, y: r.top, width: r.width, height: r.height }
  }
  return out
}
