// Download, verify and cache the System-1 model. Panel-resident (the SW never
// imports it). Integrity model: the pinned manifest hash authenticates the
// manifest; the manifest's per-file hashes authenticate each file; nothing is
// cache.put() before its hash matches, and readiness is written only after
// every file verified — a partial download is never "ready".
import { WEIGHTS_PIN, type WeightsPin } from './weightsManifest'

export { WEIGHTS_PIN }
export type { WeightsPin }
export const CACHE_NAME = 'lychee-system1'
export const STATE_KEY = 'system1State'

export interface WeightsFile { path: string; bytes: number; sha256: string }
export interface WeightsManifest {
  format: 1
  model: string
  variant: string
  files: WeightsFile[]
  /**
   * True only for a graph whose compute needs the WebGPU `shader-f16` feature
   * (the fp16 variant). A weight-only quantized graph with fp32 activations
   * does not need it. Absent (old manifests, or a variant that doesn't need
   * it) is treated as `false` by every reader — never normalized here, so a
   * manifest's own JSON stays the source of truth.
   */
  requiresShaderF16?: boolean
}
export interface System1State { revision: string; variant: string; bytes: number; readyAt: number }
export type DownloadProgress =
  | { phase: 'manifest' }
  | { phase: 'file'; path: string; received: number; overallReceived: number; overallTotal: number }
  | { phase: 'verifying'; path: string }

export interface WeightsDeps {
  fetch: typeof fetch
  cache: Pick<Cache, 'put' | 'match' | 'delete' | 'keys'>
  onProgress?: (p: DownloadProgress) => void
  signal?: AbortSignal
  /**
   * Whether this machine's WebGPU adapter has `shader-f16`. Asked only when the
   * manifest requires it, and BEFORE any model file is fetched: the f16 export
   * is ~800 MB, and downloading it onto a GPU that cannot run it would leave
   * `Act` absent after the user waited for the whole thing.
   */
  supportsShaderF16?: () => Promise<boolean>
}

export const fileUrl = (pin: WeightsPin, path: string) =>
  `https://huggingface.co/${pin.repo}/resolve/${pin.revision}/${path}`

const HEX64 = /^[0-9a-f]{64}$/
const SAFE_PATH = /^[A-Za-z0-9_.-]+$/

export function parseManifest(json: unknown): WeightsManifest {
  const m = json as Partial<WeightsManifest>
  if (!m || m.format !== 1 || typeof m.model !== 'string' || typeof m.variant !== 'string' || !Array.isArray(m.files))
    throw new Error('model manifest has an unexpected shape')
  if (m.requiresShaderF16 !== undefined && typeof m.requiresShaderF16 !== 'boolean')
    throw new Error('model manifest requiresShaderF16 must be a boolean')
  for (const f of m.files) {
    if (!f || typeof f.path !== 'string' || !SAFE_PATH.test(f.path) || f.path.includes('..'))
      throw new Error('model manifest lists an unsafe path')
    if (typeof f.bytes !== 'number' || f.bytes < 0 || typeof f.sha256 !== 'string' || !HEX64.test(f.sha256))
      throw new Error(`model manifest entry ${f.path} is malformed`)
  }
  return m as WeightsManifest
}

// Takes an ArrayBuffer-backed view (not the ArrayBufferLike-generic default)
// because that is what WebCrypto's BufferSource accepts — and every caller
// already holds one, so hashing a several-hundred-MB file costs no copy.
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Streams `res` into ONE buffer of the manifest's declared size. Collecting
 * chunks and concatenating them held every file twice at the end (~800 MB peak
 * for a 400 MB model); this holds it once. The declared size is also a hard
 * ceiling: a response that runs past it is cut off at once rather than read to
 * the end and only then rejected. Returns the filled prefix — shorter than
 * `expected` if the body ended early, which the caller's size check rejects.
 */
async function readInto(
  res: Response, expected: number, path: string, onChunk: (n: number) => void, signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const tooBig = () => new Error(`${path} is larger than its manifest says (${expected} bytes); download stopped`)
  if (!res.body) {
    const whole = new Uint8Array(await res.arrayBuffer())
    if (whole.length > expected) throw tooBig()
    onChunk(whole.length)
    return whole
  }
  const out = new Uint8Array(expected)
  const reader = res.body.getReader()
  let received = 0
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel()
      throw new DOMException('Download cancelled', 'AbortError')
    }
    const { done, value } = await reader.read()
    if (done) break
    if (received + value.length > expected) {
      await reader.cancel()
      throw tooBig()
    }
    out.set(value, received)
    received += value.length
    onChunk(value.length)
  }
  return received === expected ? out : out.subarray(0, received)
}

/** Deletes every cached entry that does not belong to `pin` — earlier revisions' weights. */
async function pruneOtherRevisions(pin: WeightsPin, cache: Pick<Cache, 'keys' | 'delete'>): Promise<void> {
  const prefix = fileUrl(pin, '')
  for (const req of await cache.keys()) if (!req.url.startsWith(prefix)) await cache.delete(req)
}

export async function downloadWeights(pin: WeightsPin, deps: WeightsDeps): Promise<System1State> {
  if (!pin.repo || !pin.revision || !pin.manifestSha256)
    throw new Error('The System-1 model is not published yet (empty WEIGHTS_PIN).')
  const { fetch: f, cache, onProgress, signal } = deps
  signal?.throwIfAborted()
  // A new pin makes the old revision's files unreachable (readState/boot only
  // ever look under the current pin), so without this each model update would
  // leave another several hundred MB behind in Cache Storage for good.
  await pruneOtherRevisions(pin, cache)
  onProgress?.({ phase: 'manifest' })
  const mRes = await f(fileUrl(pin, 'manifest.json'), { signal })
  if (!mRes.ok) throw new Error(`manifest download failed (${mRes.status})`)
  const mBytes = new Uint8Array(await mRes.arrayBuffer())
  if ((await sha256Hex(mBytes)) !== pin.manifestSha256) throw new Error('manifest hash does not match the pinned value')
  const manifest = parseManifest(JSON.parse(new TextDecoder().decode(mBytes)))
  if (manifest.requiresShaderF16 && deps.supportsShaderF16 && !(await deps.supportsShaderF16()))
    throw new Error('This model needs a GPU with WebGPU shader-f16 support, which this machine does not have; nothing was downloaded.')
  const overallTotal = manifest.files.reduce((a, x) => a + x.bytes, 0)
  let overallReceived = 0
  for (const file of manifest.files) {
    signal?.throwIfAborted()
    const res = await f(fileUrl(pin, file.path), { signal })
    if (!res.ok) throw new Error(`${file.path} download failed (${res.status})`)
    let received = 0
    const bytes = await readInto(res, file.bytes, file.path, (n) => {
      received += n
      overallReceived += n
      onProgress?.({ phase: 'file', path: file.path, received, overallReceived, overallTotal })
    }, signal)
    onProgress?.({ phase: 'verifying', path: file.path })
    if (bytes.length !== file.bytes || (await sha256Hex(bytes)) !== file.sha256)
      throw new Error(`${file.path} failed its integrity check`)
    // The very buffer that was just hashed — no copy. `bytes` is not touched
    // again after this, so nothing can mutate it between hash and put.
    await cache.put(fileUrl(pin, file.path), new Response(bytes))
  }
  // The manifest goes in last: its presence is what verifyCached/loadCachedManifest key off.
  await cache.put(fileUrl(pin, 'manifest.json'), new Response(mBytes))
  return { revision: pin.revision, variant: manifest.variant, bytes: overallTotal, readyAt: Date.now() }
}

export async function loadCachedManifest(pin: WeightsPin, cache: Pick<Cache, 'match'>): Promise<WeightsManifest | null> {
  const r = await cache.match(fileUrl(pin, 'manifest.json'))
  if (!r) return null
  try { return parseManifest(await r.json()) } catch { return null }
}

/** Presence check only (hashes were verified on the way in; re-hashing 400 MB per boot is not worth it). */
export async function verifyCached(pin: WeightsPin, manifest: WeightsManifest, cache: Pick<Cache, 'match'>): Promise<boolean> {
  for (const f of manifest.files) if (!(await cache.match(fileUrl(pin, f.path)))) return false
  return true
}

export async function readState(): Promise<System1State | null> {
  const got = await chrome.storage.local.get(STATE_KEY)
  const s = got[STATE_KEY] as System1State | undefined
  return s && s.revision === WEIGHTS_PIN.revision ? s : null
}

export async function writeState(s: System1State): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: s })
}

export async function deleteWeights(): Promise<void> {
  await chrome.storage.local.remove(STATE_KEY)
  await caches.delete(CACHE_NAME)
}
