import { describe, it, expect, vi } from 'vitest'
import { downloadWeights, fileUrl, parseManifest, verifyCached, type WeightsManifest } from './weights'

const enc = (s: string) => new TextEncoder().encode(s)
async function sha(bytes: Uint8Array) {
  // .slice() copies into a fresh ArrayBuffer-backed view — see weights.ts's sha256Hex.
  const d = await crypto.subtle.digest('SHA-256', bytes.slice())
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

class FakeCache {
  store = new Map<string, Response>()
  async put(url: string, res: Response) { this.store.set(url, res) }
  async match(url: string) { const r = this.store.get(url); return r ? r.clone() : undefined }
  async delete(key: string | Request) { return this.store.delete(typeof key === 'string' ? key : key.url) }
  async keys() { return [...this.store.keys()].map((url) => new Request(url)) }
}

async function fixture(corrupt?: string) {
  const files: Record<string, Uint8Array> = { 'model_q4.onnx': enc('MODEL'), 'von.json': enc('{"a":1}') }
  const manifest: WeightsManifest = {
    format: 1, model: 'von-1.2.0', variant: 'q4',
    files: await Promise.all(Object.entries(files).map(async ([path, b]) => ({ path, bytes: b.length, sha256: await sha(b) }))),
  }
  const manifestBytes = enc(JSON.stringify(manifest))
  const pin = { repo: 'me/von', revision: 'abc', manifestSha256: await sha(manifestBytes) }
  const fetchFn = vi.fn(async (url: string) => {
    if (url === fileUrl(pin, 'manifest.json')) return new Response(manifestBytes)
    const path = Object.keys(files).find((p) => url === fileUrl(pin, p))
    if (!path) return new Response('nope', { status: 404 })
    return new Response(path === corrupt ? enc('TAMPERED') : files[path].slice())
  })
  return { pin, manifest, fetchFn }
}

describe('parseManifest', () => {
  it('rejects a wrong format or a file without a sha256', () => {
    expect(() => parseManifest({ format: 2, files: [] })).toThrow()
    expect(() => parseManifest({ format: 1, model: 'x', variant: 'q4', files: [{ path: 'a', bytes: 1 }] })).toThrow()
  })
  it('rejects path traversal', () => {
    expect(() => parseManifest({ format: 1, model: 'x', variant: 'q4', files: [{ path: '../a', bytes: 1, sha256: 'f'.repeat(64) }] })).toThrow()
  })
  it('rejects a non-boolean requiresShaderF16', () => {
    expect(() => parseManifest({ format: 1, model: 'x', variant: 'q4', files: [], requiresShaderF16: 'yes' })).toThrow()
  })
  it('accepts requiresShaderF16 when boolean, and leaves it absent otherwise', () => {
    expect(parseManifest({ format: 1, model: 'x', variant: 'fp16', files: [], requiresShaderF16: true }).requiresShaderF16).toBe(true)
    expect(parseManifest({ format: 1, model: 'x', variant: 'q4', files: [] }).requiresShaderF16).toBeUndefined()
  })
})

describe('downloadWeights', () => {
  it('fails closed when the pin is empty', async () => {
    await expect(downloadWeights({ repo: '', revision: '', manifestSha256: '' }, { fetch: vi.fn() as any, cache: new FakeCache() }))
      .rejects.toThrow(/not published/)
  })
  it('stores every verified file and reports bytes', async () => {
    const { pin, fetchFn } = await fixture()
    const cache = new FakeCache()
    const state = await downloadWeights(pin, { fetch: fetchFn as any, cache })
    expect(state.variant).toBe('q4')
    expect(state.bytes).toBe(5 + 7)
    expect(cache.store.size).toBe(3) // manifest + 2 files
  })
  it('refuses a shader-f16 model on a GPU without the feature BEFORE downloading any file', async () => {
    const files = { 'model_f16.onnx': enc('MODEL') }
    const manifest: WeightsManifest = { format: 1, model: 'von', variant: 'f16', requiresShaderF16: true,
      files: [{ path: 'model_f16.onnx', bytes: 5, sha256: await sha(files['model_f16.onnx']) }] }
    const mBytes = enc(JSON.stringify(manifest))
    const pin = { repo: 'me/von', revision: 'f16', manifestSha256: await sha(mBytes) }
    const fetchFn = vi.fn(async (url: string) => (url === fileUrl(pin, 'manifest.json') ? new Response(mBytes) : new Response(files['model_f16.onnx'].slice())))
    const cache = new FakeCache()
    await expect(downloadWeights(pin, { fetch: fetchFn as any, cache, supportsShaderF16: async () => false })).rejects.toThrow(/shader-f16/)
    expect(fetchFn).toHaveBeenCalledTimes(1) // the manifest only
    expect(cache.store.size).toBe(0)
    const ok = await downloadWeights(pin, { fetch: fetchFn as any, cache: new FakeCache(), supportsShaderF16: async () => true })
    expect(ok.variant).toBe('f16')
  })
  it('refuses a tampered manifest', async () => {
    const { pin, fetchFn } = await fixture()
    await expect(downloadWeights({ ...pin, manifestSha256: '0'.repeat(64) }, { fetch: fetchFn as any, cache: new FakeCache() }))
      .rejects.toThrow(/manifest/)
  })
  it('refuses a tampered file and caches nothing for it', async () => {
    const { pin, fetchFn } = await fixture('model_q4.onnx')
    const cache = new FakeCache()
    await expect(downloadWeights(pin, { fetch: fetchFn as any, cache })).rejects.toThrow(/model_q4.onnx/)
    expect(await cache.match(fileUrl(pin, 'model_q4.onnx'))).toBeUndefined()
  })
  it('stops a file that runs past its manifest size, and caches nothing for it', async () => {
    const { pin, fetchFn } = await fixture()
    const cache = new FakeCache()
    let cancelled = false
    const oversized = (url: string) => {
      if (url !== fileUrl(pin, 'model_q4.onnx')) return fetchFn(url)
      // Streams far more than the 5 bytes declared, one chunk at a time.
      let sent = 0
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        pull(c) { if (sent++ < 1000) c.enqueue(enc('MODELMODEL')); else c.close() },
        cancel() { cancelled = true },
      })))
    }
    await expect(downloadWeights(pin, { fetch: vi.fn(oversized) as any, cache })).rejects.toThrow(/larger than its manifest/)
    expect(cancelled).toBe(true)
    expect(await cache.match(fileUrl(pin, 'model_q4.onnx'))).toBeUndefined()
  })
  it('rejects a file that ends short of its manifest size', async () => {
    const { pin, fetchFn } = await fixture()
    const short = (url: string) => (url === fileUrl(pin, 'model_q4.onnx')
      ? Promise.resolve(new Response(new ReadableStream({ start(c) { c.enqueue(enc('MOD')); c.close() } })))
      : fetchFn(url))
    await expect(downloadWeights(pin, { fetch: vi.fn(short) as any, cache: new FakeCache() })).rejects.toThrow(/integrity/)
  })
  it('caches the exact verified bytes', async () => {
    const { pin, fetchFn } = await fixture()
    const cache = new FakeCache()
    await downloadWeights(pin, { fetch: fetchFn as any, cache })
    expect(await (await cache.match(fileUrl(pin, 'model_q4.onnx')))!.text()).toBe('MODEL')
  })
  it("deletes an earlier revision's cached files before downloading, keeping the current pin's", async () => {
    const { pin, fetchFn } = await fixture()
    const cache = new FakeCache()
    const old = { ...pin, revision: 'old-rev' }
    const other = { ...pin, repo: 'someone/else' }
    await cache.put(fileUrl(old, 'model_q4.onnx'), new Response('OLD'))
    await cache.put(fileUrl(old, 'manifest.json'), new Response('{}'))
    await cache.put(fileUrl(other, 'model_q4.onnx'), new Response('OTHER'))
    await cache.put(fileUrl(pin, 'von.json'), new Response('{"a":1}')) // current pin: kept
    const deleted: string[] = []
    const del = cache.delete.bind(cache)
    cache.delete = async (k: string | Request) => { deleted.push(typeof k === 'string' ? k : k.url); return del(k) }
    await downloadWeights(pin, { fetch: fetchFn as any, cache })
    expect(deleted.sort()).toEqual([
      fileUrl(old, 'manifest.json'),
      fileUrl(old, 'model_q4.onnx'),
      fileUrl(other, 'model_q4.onnx'),
    ].sort())
    expect([...cache.store.keys()].every((u) => u.startsWith(fileUrl(pin, '')))).toBe(true)
    expect(cache.store.size).toBe(3)
  })
  it('honours abort', async () => {
    const { pin, fetchFn } = await fixture()
    const ac = new AbortController()
    ac.abort()
    await expect(downloadWeights(pin, { fetch: fetchFn as any, cache: new FakeCache(), signal: ac.signal })).rejects.toThrow()
  })
})

describe('verifyCached', () => {
  it('is false when any file is missing', async () => {
    const { pin, manifest, fetchFn } = await fixture()
    const cache = new FakeCache()
    await downloadWeights(pin, { fetch: fetchFn as any, cache })
    expect(await verifyCached(pin, manifest, cache)).toBe(true)
    await cache.delete(fileUrl(pin, 'von.json'))
    expect(await verifyCached(pin, manifest, cache)).toBe(false)
  })
})
