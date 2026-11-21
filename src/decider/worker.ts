// The decider worker: a module Worker that owns the onnxruntime-web session and the OPFS-backed
// embedding tables. A Vite entry point (dist/deciderWorker.js), spawned by engine.ts. Thin by
// design: rendering, packing, readout and table math all live in tested pure modules.

import * as ort from 'onnxruntime-web/webgpu'
import { createEncoder } from './tokenizer'
import { parseManifest, type DeciderManifest } from './manifest'
import { renderRequest } from './prompt'
import { packPass } from './pack'
import { codeProbabilities, toAnswer, type Answer } from './readout'
import { TableReader } from './tables'
import type { DeciderWorkerReply, DeciderWorkerRequest } from './protocol'
import type { DecisionRequest } from './request'
import type { EncodeText } from './prompt'

const post = (msg: DeciderWorkerReply) => self.postMessage(msg)

interface SyncHandle {
  read(buf: Uint8Array, opts: { at: number }): number
  close(): void
}

interface Boot {
  manifest: DeciderManifest
  encode: EncodeText
  session: ort.InferenceSession
  embed: TableReader
  ple: TableReader
  handles: SyncHandle[]
  urls: string[]
  backend: 'webgpu' | 'wasm'
}

let boot: Boot | null = null
let starting = false
let cold = true

async function modelDir(modelId: string): Promise<FileSystemDirectoryHandle> {
  let dir = await navigator.storage.getDirectory()
  for (const part of ['decider', modelId]) dir = await dir.getDirectoryHandle(part)
  return dir
}

async function readJson(dir: FileSystemDirectoryHandle, name: string): Promise<Record<string, unknown>> {
  const file = await (await dir.getFileHandle(name)).getFile()
  return JSON.parse(await file.text())
}

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) != null
  } catch {
    return false
  }
}

async function open(modelId: string, wasmUrl: string): Promise<{ boot: Boot; bootMs: number }> {
  const t0 = performance.now()
  const dir = await modelDir(modelId)
  const manifest = parseManifest(await readJson(dir, 'manifest.json'))
  const encode = createEncoder(await readJson(dir, 'tokenizer.json'), await readJson(dir, 'tokenizer_config.json'))

  const handles: SyncHandle[] = []
  const urls: string[] = []
  try {
    const openTable = async (file: string): Promise<SyncHandle> => {
      const fh = (await dir.getFileHandle(file)) as FileSystemFileHandle & {
        createSyncAccessHandle(): Promise<SyncHandle>
      }
      const h = await fh.createSyncAccessHandle()
      handles.push(h)
      return h
    }
    const { blockSize, embed, ple } = manifest.tables
    const embedReader = new TableReader(await openTable(embed.file), embed.blocks, blockSize)
    const pleReader = new TableReader(await openTable(ple.file), ple.blocks, blockSize)

    const blobUrl = async (name: string) => {
      const url = URL.createObjectURL(await (await dir.getFileHandle(name)).getFile())
      urls.push(url)
      return url
    }
    const torsoUrl = await blobUrl('torso.onnx')
    const dataUrl = await blobUrl('torso.onnx.data')

    ort.env.wasm.wasmPaths = { wasm: wasmUrl }
    // Extension pages are not cross-origin isolated, so there is no SharedArrayBuffer to thread on.
    ort.env.wasm.numThreads = 1
    const backend: 'webgpu' | 'wasm' = (await hasWebGpu()) ? 'webgpu' : 'wasm'
    const session = await ort.InferenceSession.create(torsoUrl, {
      executionProviders: [backend],
      graphOptimizationLevel: 'all',
      externalData: [{ path: 'torso.onnx.data', data: dataUrl }],
    })
    return {
      boot: { manifest, encode, session, embed: embedReader, ple: pleReader, handles, urls, backend },
      bootMs: Math.round(performance.now() - t0),
    }
  } catch (err) {
    for (const h of handles) h.close()
    for (const u of urls) URL.revokeObjectURL(u)
    throw err
  }
}

async function decide(b: Boot, request: DecisionRequest) {
  const t0 = performance.now()
  const { manifest } = b
  const rendered = renderRequest(request, b.encode, manifest.controlTokenIds)
  const packed = packPass(rendered.stateIds, rendered.questions.map((q) => q.ids))
  const T = packed.ids.length
  if (T > manifest.maxLength) throw new Error(`too-long: ${T} tokens exceeds ${manifest.maxLength}`)

  const embeds = new Float32Array(T * manifest.hidden)
  const ple = new Float32Array(T * manifest.layers * manifest.pleDim)
  b.embed.rows(packed.ids, embeds)
  b.ple.rows(packed.ids, ple)

  const feeds = {
    inputs_embeds: new ort.Tensor('float32', embeds, [1, T, manifest.hidden]),
    per_layer_raw: new ort.Tensor('float32', ple, [1, T, manifest.layers, manifest.pleDim]),
    position_ids: new ort.Tensor('int64', BigInt64Array.from(packed.positions, BigInt), [1, T]),
    segment_ids: new ort.Tensor('int64', BigInt64Array.from(packed.segments, BigInt), [T]),
    gather_idx: new ort.Tensor('int64', BigInt64Array.from(packed.gather, BigInt), [packed.gather.length]),
  }
  const out = await b.session.run(feeds, ['logits'])
  const logits = (await out.logits.getData()) as Float32Array
  const answers: Record<string, Answer> = {}
  rendered.questions.forEach((q, row) => {
    const probs = codeProbabilities(logits, row, q.options.length, manifest.softcap, manifest.temperature)
    answers[q.name] = toAnswer(q, probs)
  })
  return { answers, ms: Math.round(performance.now() - t0), tokens: T, backend: b.backend }
}

async function release() {
  const b = boot
  boot = null
  if (!b) return
  try {
    await b.session.release()
  } catch {
    /* best effort */
  }
  for (const h of b.handles) h.close()
  for (const u of b.urls) URL.revokeObjectURL(u)
}

self.onmessage = async (e: MessageEvent<DeciderWorkerRequest>) => {
  const msg = e.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'init') {
    if (boot) return post({ type: 'ready', backend: boot.backend, bootMs: 0 })
    if (starting) return
    starting = true
    try {
      const r = await open(msg.modelId, msg.wasmUrl)
      boot = r.boot
      cold = true
      post({ type: 'ready', backend: r.boot.backend, bootMs: r.bootMs })
    } catch (err) {
      post({ type: 'boot-failed', message: err instanceof Error ? err.message : String(err) })
    } finally {
      starting = false
    }
    return
  }

  if (msg.type === 'decide') {
    if (!boot) return post({ type: 'failed', id: msg.id, message: 'decider not initialised' })
    try {
      const r = await decide(boot, msg.request)
      post({ type: 'result', id: msg.id, result: { ...r, cold } })
      cold = false
    } catch (err) {
      post({ type: 'failed', id: msg.id, message: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  if (msg.type === 'dispose') await release()
}
