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
export interface WeightsManifest { format: 1; model: string; variant: string; files: WeightsFile[] }
export interface System1State { revision: string; variant: string; bytes: number; readyAt: number }
export type DownloadProgress =
  | { phase: 'manifest' }
  | { phase: 'file'; path: string; received: number; overallReceived: number; overallTotal: number }
  | { phase: 'verifying'; path: string }

export interface WeightsDeps {
  fetch: typeof fetch
  cache: Pick<Cache, 'put' | 'match' | 'delete'>
  onProgress?: (p: DownloadProgress) => void
  signal?: AbortSignal
}

export const fileUrl = (pin: WeightsPin, path: string) =>
  `https://huggingface.co/${pin.repo}/resolve/${pin.revision}/${path}`

const HEX64 = /^[0-9a-f]{64}$/
const SAFE_PATH = /^[A-Za-z0-9_.-]+$/

export function parseManifest(json: unknown): WeightsManifest {
  const m = json as Partial<WeightsManifest>
  if (!m || m.format !== 1 || typeof m.model !== 'string' || typeof m.variant !== 'string' || !Array.isArray(m.files))
    throw new Error('model manifest has an unexpected shape')
  for (const f of m.files) {
    if (!f || typeof f.path !== 'string' || !SAFE_PATH.test(f.path) || f.path.includes('..'))
      throw new Error('model manifest lists an unsafe path')
    if (typeof f.bytes !== 'number' || f.bytes < 0 || typeof f.sha256 !== 'string' || !HEX64.test(f.sha256))
      throw new Error(`model manifest entry ${f.path} is malformed`)
  }
  return m as WeightsManifest
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // .slice() copies into a fresh ArrayBuffer-backed view — a plain Uint8Array
  // is ArrayBufferLike-generic, which WebCrypto's BufferSource
  // (ArrayBufferView<ArrayBuffer>) rejects. Same fix as src/data/vault.ts.
  const d = await crypto.subtle.digest('SHA-256', bytes.slice())
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function readAll(res: Response, onChunk: (n: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer())
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel()
      throw new DOMException('Download cancelled', 'AbortError')
    }
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
    onChunk(value.length)
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

export async function downloadWeights(pin: WeightsPin, deps: WeightsDeps): Promise<System1State> {
  if (!pin.repo || !pin.revision || !pin.manifestSha256)
    throw new Error('The System-1 model is not published yet (empty WEIGHTS_PIN).')
  const { fetch: f, cache, onProgress, signal } = deps
  signal?.throwIfAborted()
  onProgress?.({ phase: 'manifest' })
  const mRes = await f(fileUrl(pin, 'manifest.json'), { signal })
  if (!mRes.ok) throw new Error(`manifest download failed (${mRes.status})`)
  const mBytes = new Uint8Array(await mRes.arrayBuffer())
  if ((await sha256Hex(mBytes)) !== pin.manifestSha256) throw new Error('manifest hash does not match the pinned value')
  const manifest = parseManifest(JSON.parse(new TextDecoder().decode(mBytes)))
  const overallTotal = manifest.files.reduce((a, x) => a + x.bytes, 0)
  let overallReceived = 0
  for (const file of manifest.files) {
    signal?.throwIfAborted()
    const res = await f(fileUrl(pin, file.path), { signal })
    if (!res.ok) throw new Error(`${file.path} download failed (${res.status})`)
    let received = 0
    const bytes = await readAll(res, (n) => {
      received += n
      overallReceived += n
      onProgress?.({ phase: 'file', path: file.path, received, overallReceived, overallTotal })
    }, signal)
    onProgress?.({ phase: 'verifying', path: file.path })
    if (bytes.length !== file.bytes || (await sha256Hex(bytes)) !== file.sha256)
      throw new Error(`${file.path} failed its integrity check`)
    await cache.put(fileUrl(pin, file.path), new Response(bytes.slice()))
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
