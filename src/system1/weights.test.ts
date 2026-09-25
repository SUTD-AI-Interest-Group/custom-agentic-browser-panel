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
  async delete(url: string) { return this.store.delete(url) }
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
