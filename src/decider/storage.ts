// OPFS model storage: import (with per-chunk SHA-256 verification), status, delete.
// Layout: decider/<manifest.modelId>/<file name>. Status lives in chrome.storage.local
// under MODEL_STATUS_KEY so the panel and worker agree on what is usable.

import { MODEL_ID, MODEL_STATUS_KEY } from './config'
import { parseManifest, type DeciderManifest } from './manifest'

export type ModelStatus =
  | { state: 'absent' }
  | { state: 'importing'; done: number; total: number }
  | { state: 'ready'; modelId: string; bytes: number; importedAt: number }
  | { state: 'failed'; message: string }

export type ImportSource = { kind: 'files'; files: File[] } | { kind: 'url'; baseUrl: string }

const ROOT_DIR = 'decider'
const PROGRESS_INTERVAL_MS = 250

// An import running in THIS JS context. A stored `importing` status with no such import is a
// leftover from a closed/crashed page, so it must never read as live (or as ready). A flag
// (rather than a heartbeat/timestamp) keeps this deterministic; the cost is that a second
// panel context sees another context's live import as 'interrupted', which is the safe side.
let importingHere = false

// Test seam: OPFS does not exist in node/jsdom.
let rootOverride: FileSystemDirectoryHandle | undefined
export function __setRootForTests(root: FileSystemDirectoryHandle | undefined): void {
  rootOverride = root
}
const getRoot = (): Promise<FileSystemDirectoryHandle> =>
  rootOverride ? Promise.resolve(rootOverride) : navigator.storage.getDirectory()

export function chunkRanges(bytes: number, chunkBytes: number): { offset: number; length: number }[] {
  const out: { offset: number; length: number }[] = []
  for (let offset = 0; offset < bytes; offset += chunkBytes) {
    out.push({ offset, length: Math.min(chunkBytes, bytes - offset) })
  }
  return out
}

async function setStatus(s: ModelStatus): Promise<void> {
  await chrome.storage.local.set({ [MODEL_STATUS_KEY]: s })
}

export async function getModelStatus(): Promise<ModelStatus> {
  const got = await chrome.storage.local.get(MODEL_STATUS_KEY)
  const s = got[MODEL_STATUS_KEY] as ModelStatus | undefined
  if (!s || typeof s !== 'object' || typeof s.state !== 'string') return { state: 'absent' }
  if (s.state === 'importing' && !importingHere) return { state: 'failed', message: 'import was interrupted' }
  return s
}

export async function isModelReady(): Promise<boolean> {
  const s = await getModelStatus()
  return s.state === 'ready' && s.modelId === MODEL_ID
}

export async function deleteModel(): Promise<void> {
  const root = await getRoot()
  try {
    const dir = await root.getDirectoryHandle(ROOT_DIR)
    await dir.removeEntry(MODEL_ID, { recursive: true })
  } catch (e) {
    if (!(e instanceof Error && e.name === 'NotFoundError')) throw e
  }
  await setStatus({ state: 'absent' })
}

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const pickFile = (files: File[], name: string): File | undefined =>
  files.find((x) => baseName(x.webkitRelativePath || x.name) === name || x.name === name)

async function openStream(src: ImportSource, name: string): Promise<ReadableStream<Uint8Array>> {
  if (src.kind === 'files') {
    const f = pickFile(src.files, name)
    if (!f) throw new Error(`${name}: file was not selected`)
    return f.stream() as ReadableStream<Uint8Array>
  }
  const r = await fetch(`${src.baseUrl.replace(/\/+$/, '')}/${name}`)
  if (!r.ok || !r.body) throw new Error(`${name}: download failed (${r.status})`)
  return r.body
}

async function readManifestText(src: ImportSource): Promise<string> {
  if (src.kind === 'files') {
    const f = pickFile(src.files, 'manifest.json')
    if (!f) throw new Error('manifest.json was not selected')
    return f.text()
  }
  const r = await fetch(`${src.baseUrl.replace(/\/+$/, '')}/manifest.json`)
  if (!r.ok) throw new Error(`manifest.json: download failed (${r.status})`)
  return r.text()
}

function concat(parts: Uint8Array[], len: number): Uint8Array {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.byteLength
  }
  return out
}

/** Stream one file into the directory, hashing each chunkBytes slice before it is written.
 *  At most one chunk is ever held in memory. */
async function writeVerified(
  dir: FileSystemDirectoryHandle,
  stream: ReadableStream<Uint8Array>,
  entry: DeciderManifest['files'][number],
  chunkBytes: number,
  onBytes: (n: number) => void,
): Promise<void> {
  const handle = await dir.getFileHandle(entry.name, { create: true })
  const writable = await handle.createWritable()
  const reader = stream.getReader()
  let pending: Uint8Array[] = []
  let pendingLen = 0
  let chunkIndex = 0
  let total = 0
  const flush = async (bytes: Uint8Array): Promise<void> => {
    const want = entry.sha256[chunkIndex]
    const got = hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
    if (want === undefined || got !== want) {
      throw new Error(`${entry.name}: hash mismatch in chunk ${chunkIndex}`)
    }
    await writable.write(bytes as BufferSource)
    chunkIndex++
    total += bytes.byteLength
    onBytes(bytes.byteLength)
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) {
        pending.push(value)
        pendingLen += value.byteLength
        while (pendingLen >= chunkBytes) {
          const joined = concat(pending, pendingLen)
          await flush(joined.subarray(0, chunkBytes))
          const rest = joined.subarray(chunkBytes)
          pending = rest.byteLength ? [rest] : []
          pendingLen = rest.byteLength
        }
      }
      if (done) break
    }
    if (pendingLen > 0) await flush(concat(pending, pendingLen))
    if (total !== entry.bytes || chunkIndex !== entry.sha256.length) {
      throw new Error(`${entry.name}: size mismatch (${total} of ${entry.bytes} bytes)`)
    }
    await writable.close()
  } catch (e) {
    await writable.abort?.().catch(() => {})
    reader.cancel().catch(() => {})
    throw e
  }
}

/** Import never throws: the outcome is the status record (`ready` or `failed` + message). */
export async function importModel(
  src: ImportSource,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  // One import at a time per context: a second call resolves immediately, touching neither
  // OPFS nor the running import's status (importingHere stays true until that one finishes).
  if (importingHere) return
  importingHere = true
  let lastProgress: Promise<void> = Promise.resolve()
  try {
    // Claim the status before any byte moves, so a crash mid-import reads as interrupted.
    await setStatus({ state: 'importing', done: 0, total: 0 })
    void Promise.resolve(navigator.storage?.persist?.()).catch(() => {})
    const text = await readManifestText(src)
    const manifest = parseManifest(JSON.parse(text))
    if (manifest.modelId !== MODEL_ID) {
      throw new Error(`manifest is for ${manifest.modelId}, expected ${MODEL_ID}`)
    }
    const total = manifest.files.reduce((n, f) => n + f.bytes, 0)
    await setStatus({ state: 'importing', done: 0, total })

    const root = await getRoot()
    const parent = await root.getDirectoryHandle(ROOT_DIR, { create: true })
    // Start clean so a previous partial import can't leave stale files behind.
    await parent.removeEntry(manifest.modelId, { recursive: true }).catch(() => {})
    const dir = await parent.getDirectoryHandle(manifest.modelId, { create: true })

    let done = 0
    let lastWrite = 0
    const onBytes = (n: number): void => {
      done += n
      onProgress?.(done, total)
      const now = Date.now()
      if (now - lastWrite >= PROGRESS_INTERVAL_MS) {
        lastWrite = now
        lastProgress = setStatus({ state: 'importing', done, total }).catch(() => {})
      }
    }
    for (const entry of manifest.files) {
      await writeVerified(dir, await openStream(src, entry.name), entry, manifest.chunkBytes, onBytes)
    }
    // The worker reads the manifest from OPFS.
    const mw = await (await dir.getFileHandle('manifest.json', { create: true })).createWritable()
    await mw.write(text)
    await mw.close()

    await lastProgress // a late progress write must not land after `ready`
    await setStatus({ state: 'ready', modelId: manifest.modelId, bytes: total, importedAt: Date.now() })
  } catch (e) {
    try {
      const parent = await (await getRoot()).getDirectoryHandle(ROOT_DIR)
      await parent.removeEntry(MODEL_ID, { recursive: true })
    } catch {
      // nothing to clean up
    }
    await lastProgress // `failed` must be the last status write
    try {
      await setStatus({ state: 'failed', message: e instanceof Error ? e.message : String(e) })
    } catch {
      // storage itself is unavailable; importModel never throws
    }
  } finally {
    importingHere = false
  }
}
