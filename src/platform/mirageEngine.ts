/** Lazy, reusable local perception worker. Never captures images or grants access. */
export interface MirageResult {
  result: unknown
  timing: { loadMs: number; inferenceMs: number; totalMs: number }
  /** WASM linear memory capacity, not total browser RSS. */
  heapBytes: number
}
let worker: Worker | undefined
let sequence = 0
let idle: ReturnType<typeof setTimeout> | undefined
let pending: { id: number; resolve(value: MirageResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined
const TIMEOUT_MS = 30_000
const IDLE_MS = 60_000
export function disposeMirage(): void {
  clearTimeout(idle)
  worker?.terminate()
  worker = undefined
  if (pending) {
    clearTimeout(pending.timer)
    pending.reject(new Error('Local Mirage perception was stopped'))
    pending = undefined
  }
}
export function describeMirage(dataUrl: string): Promise<MirageResult> {
  return requestMirage(dataUrl, false)
}
/** Separate image-only form request: does not run OCR or summarize chat. */
export function classifyMirage(dataUrl: string): Promise<MirageResult> {
  return requestMirage(dataUrl, true)
}
function requestMirage(dataUrl: string, decision: boolean): Promise<MirageResult> {
  if (pending) return Promise.reject(new Error('Local Mirage perception is busy'))
  if (typeof dataUrl !== 'string' || dataUrl.length > 24 * 1024 * 1024 || !/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)) return Promise.reject(new Error('Unsupported Mirage image'))
  clearTimeout(idle)
  if (!worker) {
    const current = worker = new Worker(chrome.runtime.getURL('mirageWorker.js'), { type: 'module' })
    current.onerror = () => { if (worker === current) disposeMirage() }
    current.onmessage = (event) => {
      if (worker !== current || !pending || event.data?.id !== pending.id) return
      const request = pending
      pending = undefined
      clearTimeout(request.timer)
      if (event.data.error) {
        worker?.terminate(); worker = undefined
        request.reject(new Error('Local Mirage perception is unavailable'))
      } else {
        request.resolve(event.data.value as MirageResult)
        idle = setTimeout(disposeMirage, IDLE_MS)
      }
    }
  }
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending = { id, resolve, reject, timer: setTimeout(disposeMirage, TIMEOUT_MS) }
    try { worker!.postMessage({ id, dataUrl, decision }) } catch { disposeMirage() }
  })
}
// A mode change revokes in-flight delivery and releases model memory.
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings && (
      changes.settings.oldValue?.mirageMode !== changes.settings.newValue?.mirageMode ||
      changes.settings.oldValue?.mirageDecisionMode !== changes.settings.newValue?.mirageDecisionMode
    )) disposeMirage()
  })
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', disposeMirage)
