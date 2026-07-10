// Set-of-marks: capture a clean screenshot of the tab and draw the registry's
// numbered boxes onto it, so a vision model can pick an element by number. The
// same [index] maps to the same DOM node the text registry uses.

import type { IndexedElement } from './domIndex'

const MAX_SIDE = 1400

/** Screenshot the tab and overlay numbered boxes for each indexed element. */
export async function captureWithMarks(
  tabId: number,
  windowId: number,
  elements: IndexedElement[],
  dpr: number,
): Promise<string> {
  const shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Failed to decode screenshot.'))
    img.src = shot
  })
  const down = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.naturalWidth * down)
  canvas.height = Math.round(img.naturalHeight * down)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  ctx.font = 'bold 12px system-ui'
  for (const el of elements) {
    const x = el.rect.x * dpr * down
    const y = el.rect.y * dpr * down
    const w = el.rect.width * dpr * down
    const h = el.rect.height * dpr * down
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
