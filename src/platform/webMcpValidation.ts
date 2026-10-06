/** Hostile JSON Schema can contain catastrophic regexes or recursive refs.
 * Both schema construction and validation run off-thread with termination. */
export interface ValidationWorker {
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: unknown): void
  terminate(): void
}
const createWorker = (): ValidationWorker => new Worker(new URL('./webMcpValidationWorker.ts', import.meta.url), { type: 'module' })

export function validateSiteInput(
  schema: Record<string, unknown>, args: Record<string, unknown>, signal?: AbortSignal,
  factory: () => ValidationWorker = createWorker,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    let worker: ValidationWorker
    try { worker = factory() } catch { resolve(false); return }
    let settled = false
    const finish = (valid: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      worker.terminate()
      resolve(valid)
    }
    const cancel = () => finish(false)
    const timer = setTimeout(cancel, 1500)
    worker.onmessage = (event) => finish(event.data?.valid === true)
    worker.onerror = () => finish(false)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) { finish(false); return }
    try { worker.postMessage({ schema, args }) } catch { finish(false) }
  })
}
