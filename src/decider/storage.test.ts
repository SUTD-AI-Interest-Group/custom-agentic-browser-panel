import { File as NodeFile } from 'node:buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MODEL_ID, MODEL_STATUS_KEY } from './config'
import {
  __setRootForTests,
  chunkRanges,
  deleteModel,
  getModelStatus,
  importModel,
  isModelReady,
} from './storage'

// ---- in-memory OPFS fake (only the surface storage.ts uses) ----
class FakeDir {
  dirs = new Map<string, FakeDir>()
  files = new Map<string, { data: Uint8Array }>()
  onWrite?: () => void
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    let d = this.dirs.get(name)
    if (!d) {
      if (!opts?.create) throw Object.assign(new Error('nf'), { name: 'NotFoundError' })
      d = new FakeDir()
      d.onWrite = this.onWrite
      this.dirs.set(name, d)
    }
    return d
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let f = this.files.get(name)
    if (!f) {
      if (!opts?.create) throw Object.assign(new Error('nf'), { name: 'NotFoundError' })
      f = { data: new Uint8Array(0) }
      this.files.set(name, f)
    }
    const file = f
    const hook = () => this.onWrite?.()
    return {
      async createWritable() {
        file.data = new Uint8Array(0)
        return {
          async write(c: BufferSource | string) {
            hook()
            const b = typeof c === 'string' ? new TextEncoder().encode(c) : new Uint8Array(c as ArrayBuffer)
            const n = new Uint8Array(file.data.length + b.length)
            n.set(file.data)
            n.set(b, file.data.length)
            file.data = n
          },
          async close() {},
          async abort() {},
        }
      },
    }
  }
  async removeEntry(name: string) {
    if (!this.dirs.delete(name) && !this.files.delete(name)) {
      throw Object.assign(new Error('nf'), { name: 'NotFoundError' })
    }
  }
}

function stubChrome(): Record<string, unknown> {
  const store: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (k: string) => (k in store ? { [k]: store[k] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(store, items)),
      },
    },
  })
  return store
}

async function sha(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', b as BufferSource)
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('')
}

const CHUNK = 4
async function bundle(corrupt = false) {
  const body = new TextEncoder().encode('0123456789') // 3 chunks: 4,4,2
  const hashes = [await sha(body.slice(0, 4)), await sha(body.slice(4, 8)), await sha(body.slice(8))]
  if (corrupt) hashes[1] = '0'.repeat(64)
  const manifest = {
    format: 1,
    modelId: MODEL_ID,
    revision: 'r',
    hidden: 1,
    layers: 1,
    pleDim: 1,
    vocab: 1,
    temperature: 1,
    softcap: 1,
    maxLength: 1,
    controlTokenIds: {},
    codeTokenIds: [],
    tables: { blockSize: 1, embed: { file: 'w.bin', blocks: 1 }, ple: { file: 'w.bin', blocks: 1 } },
    chunkBytes: CHUNK,
    files: [{ name: 'w.bin', bytes: body.length, sha256: hashes }],
  }
  const files = [
    new NodeFile([JSON.stringify(manifest)], 'manifest.json'),
    new NodeFile([body], 'w.bin'),
  ] as unknown as File[]
  return { manifest, files }
}

let root: FakeDir
let store: Record<string, unknown>
beforeEach(() => {
  root = new FakeDir()
  store = stubChrome()
  __setRootForTests(root as unknown as FileSystemDirectoryHandle)
  vi.stubGlobal('navigator', { storage: { persist: vi.fn(async () => true) } })
})

describe('chunkRanges', () => {
  it('splits with a short tail', () => {
    expect(chunkRanges(150, 64)).toEqual([
      { offset: 0, length: 64 },
      { offset: 64, length: 64 },
      { offset: 128, length: 22 },
    ])
  })
})

describe('importModel', () => {
  it('writes importing before the first byte, verifies, and ends ready', async () => {
    const { files } = await bundle()
    const statuses: unknown[] = []
    root.onWrite = () => statuses.push(structuredClone(store[MODEL_STATUS_KEY]))
    const progress: number[] = []
    await importModel({ kind: 'files', files }, (d) => progress.push(d))
    expect(statuses[0]).toMatchObject({ state: 'importing', done: 0, total: 10 })
    expect(progress.at(-1)).toBe(10)
    const s = await getModelStatus()
    expect(s).toMatchObject({ state: 'ready', modelId: MODEL_ID, bytes: 10 })
    expect(await isModelReady()).toBe(true)
    const dir = root.dirs.get('decider')!.dirs.get(MODEL_ID)!
    expect(new TextDecoder().decode(dir.files.get('w.bin')!.data)).toBe('0123456789')
    expect(dir.files.has('manifest.json')).toBe(true)
    expect(navigator.storage.persist).toHaveBeenCalledTimes(1)
  })

  it('fails naming the file on a chunk hash mismatch and leaves nothing behind', async () => {
    const { files } = await bundle(true)
    await importModel({ kind: 'files', files })
    const s = await getModelStatus()
    expect(s.state).toBe('failed')
    expect((s as { message: string }).message).toContain('w.bin')
    expect(await isModelReady()).toBe(false)
    expect(root.dirs.get('decider')!.dirs.has(MODEL_ID)).toBe(false)
  })

  it('streams a url source', async () => {
    const { files } = await bundle()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        const name = u.split('/').pop()!
        const f = files.find((x) => x.name === name)!
        return new Response(f.stream(), { status: 200 })
      }),
    )
    await importModel({ kind: 'url', baseUrl: 'https://x.test/m/' })
    expect(await isModelReady()).toBe(true)
  })
})

describe('getModelStatus', () => {
  it('reads a stored importing status at startup as interrupted, never ready', async () => {
    store[MODEL_STATUS_KEY] = { state: 'importing', done: 5, total: 10 }
    expect(await getModelStatus()).toEqual({ state: 'failed', message: 'import was interrupted' })
    expect(await isModelReady()).toBe(false)
  })

  it('reports importing while an import runs in this context', async () => {
    const { files } = await bundle()
    let mid: unknown
    root.onWrite = () => (mid ??= null)
    const p = importModel({ kind: 'files', files }, async () => {
      mid ??= await getModelStatus()
    })
    await p
    expect(mid).toMatchObject({ state: 'importing' })
  })

  it('is absent with nothing stored; a ready status for another model is not ready', async () => {
    expect(await getModelStatus()).toEqual({ state: 'absent' })
    store[MODEL_STATUS_KEY] = { state: 'ready', modelId: 'other', bytes: 1, importedAt: 1 }
    expect(await isModelReady()).toBe(false)
  })
})

describe('deleteModel', () => {
  it('removes the directory and sets absent', async () => {
    const { files } = await bundle()
    await importModel({ kind: 'files', files })
    await deleteModel()
    expect(root.dirs.get('decider')!.dirs.has(MODEL_ID)).toBe(false)
    expect(await getModelStatus()).toEqual({ state: 'absent' })
  })

  it('is fine when nothing was imported', async () => {
    await deleteModel()
    expect(await getModelStatus()).toEqual({ state: 'absent' })
  })
})
