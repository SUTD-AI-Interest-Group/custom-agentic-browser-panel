// Dedicated module worker: no page access, no remote URLs, no action execution.
export {}
type Runtime = {
  HEAPU8: Uint8Array
  _malloc(size: number): number
  _free(ptr: number): void
  _cactus_load(ptr: number, length: bigint): number
  _cactus_models(): number
  _cactus_describe(rgb: number, width: number, height: number, options: number, language: number, keywords: number, output: number, size: number): number
  UTF8ToString(ptr: number): string
}
let runtime: Runtime | undefined
let busy = false
const options = { sections: ['objects', 'text'], fields: ['bbox', 'score'], max_objects: 24, max_text_lines: 48, max_tokens: 192, conf: 0.5, text_conf: 0.5 }
const local = (name: string) => new URL(`mirage/${name}`, self.location.href).href
async function bytes(name: string) {
  const response = await fetch(local(name))
  if (!response.ok) throw new Error('Packaged Mirage assets are unavailable. Build with the optional Mirage assets.')
  return new Uint8Array(await response.arrayBuffer())
}
async function load() {
  if (runtime) return runtime
  const url = local('cactus.mjs')
  const [{ default: factory }, wasmBinary, weights] = await Promise.all([
    import(/* @vite-ignore */ url), bytes('cactus.wasm'), bytes('mirage.cact'),
  ])
  const engine: Runtime = await factory({ wasmBinary })
  const ptr = engine._malloc(weights.length)
  if (!ptr) throw new Error('Mirage allocation failed')
  try {
    engine.HEAPU8.set(weights, ptr)
    if (engine._cactus_load(ptr, BigInt(weights.length)) < 0 || !(engine._cactus_models() & 4)) throw new Error('Mirage model could not load')
  } finally { engine._free(ptr) }
  runtime = engine
  return engine
}
self.onmessage = async (event: MessageEvent<{ id: number; dataUrl: string }>) => {
  const { id, dataUrl } = event.data
  if (busy) { self.postMessage({ id, error: 'Mirage is busy' }); return }
  busy = true
  const totalStart = performance.now()
  let bitmap: ImageBitmap | undefined
  try {
    if (typeof dataUrl !== 'string' || dataUrl.length > 24 * 1024 * 1024 || !/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)) throw new Error('Unsupported Mirage image')
    const blob = await (await fetch(dataUrl)).blob()
    bitmap = await createImageBitmap(blob)
    if (bitmap.width * bitmap.height > 32_000_000) throw new Error('Mirage image is too large')
    // Bound working memory; keep aspect ratio. Full-page downscaling loses detail;
    // callers should prefer viewport/element captures and disclose this limit.
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0, width, height)
    const rgba = context.getImageData(0, 0, width, height).data
    const rgb = new Uint8Array(width * height * 3)
    for (let i = 0, j = 0; i < rgba.length; i += 4) { rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2] }
    const startLoad = performance.now()
    const engine = await load()
    const loadMs = performance.now() - startLoad
    const allocated: number[] = []
    const allocate = (size: number) => { const ptr = engine._malloc(size); if (!ptr) throw new Error('Mirage allocation failed'); allocated.push(ptr); return ptr }
    try {
      const input = allocate(rgb.length)
      engine.HEAPU8.set(rgb, input)
      const json = new TextEncoder().encode(JSON.stringify(options) + '\0')
      const opts = allocate(json.length)
      engine.HEAPU8.set(json, opts)
      const outputSize = 1024 * 1024
      const output = allocate(outputSize)
      engine.HEAPU8[output] = 0
      const startInference = performance.now()
      const code = engine._cactus_describe(input, width, height, opts, 0, 0, output, outputSize)
      const inferenceMs = performance.now() - startInference
      if (code < 0) throw new Error('Mirage inference failed')
      const result: unknown = JSON.parse(engine.UTF8ToString(output))
      self.postMessage({ id, value: { result, timing: { loadMs, inferenceMs, totalMs: performance.now() - totalStart }, heapBytes: engine.HEAPU8.buffer.byteLength } })
    } finally { allocated.forEach(ptr => engine._free(ptr)) }
  } catch {
    // Avoid sending page bytes or runtime internals into logs/model context.
    self.postMessage({ id, error: 'Local Mirage perception is unavailable. Check packaged assets and retry an approved screenshot.' })
  } finally { bitmap?.close(); busy = false }
}
