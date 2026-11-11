// Canvas operations shared by panel pages and the background service worker.
export type DrawingCanvas = HTMLCanvasElement | OffscreenCanvas
export function drawingCanvas(): DrawingCanvas {
  return typeof document === 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas')
}
export function drawingContext(canvas: DrawingCanvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!context) throw new Error('Canvas is unavailable.')
  return context
}
export async function canvasDataUrl(canvas: DrawingCanvas, type = 'image/png', quality?: number): Promise<string> {
  if ('toDataURL' in canvas) return canvas.toDataURL(type, quality)
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type, quality })).arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return `data:${type};base64,${btoa(binary)}`
}
export async function drawingImage(src: string): Promise<ImageBitmap> {
  return createImageBitmap(await (await fetch(src)).blob())
}
