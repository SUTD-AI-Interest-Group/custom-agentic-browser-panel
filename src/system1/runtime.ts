// Whether this chain gets an Act tool at all: toggle on, weights ready for the
// pinned revision and present in the cache, a WebGPU adapter with the fp16
// graph's required feature, and an engine that has not failed. Any "no" →
// undefined → the tool is never built.
import type { Settings } from '../data/settings'
import { system1Enabled } from '../data/settings'
import { getSystem1Engine } from './engine'
import type { DecideRequest, DecideResult } from './protocol'
import { CACHE_NAME, WEIGHTS_PIN, loadCachedManifest, readState, verifyCached } from './weights'

export interface System1Runtime { decide(req: DecideRequest): Promise<DecideResult> }

// No "@webgpu/types" dependency in this project — onnxruntime-common's own
// `TryGetGlobalType` helper falls back to `unknown` without it (see worker.ts),
// so there is nothing to gain from adding it just for this probe. This is the
// narrow surface `requestAdapter` actually needs.
interface MinimalGpuAdapter {
  features: { has(name: string): boolean }
}
interface MinimalGpu {
  requestAdapter(): Promise<MinimalGpuAdapter | null>
}

let adapterProbe: Promise<boolean> | null = null

/**
 * True only when a WebGPU adapter exists AND advertises `shader-f16` — the
 * fp16 graph (the only exported variant; q4 failed parity, see Task 1) needs
 * it, so without the feature the tool must be absent rather than offered and
 * fail at boot. Cached for the life of the context: an adapter's feature set
 * cannot change without a context reload, same rationale as
 * `pageAccess.ts`'s `fileAccessGranted()` cache.
 */
export function hasWebGpu(): Promise<boolean> {
  if (!adapterProbe) {
    const gpu = (navigator as Navigator & { gpu?: MinimalGpu }).gpu
    adapterProbe = gpu
      ? gpu.requestAdapter().then((a) => a != null && a.features.has('shader-f16'), () => false)
      : Promise.resolve(false)
  }
  return adapterProbe
}

export async function resolveSystem1(settings: Settings): Promise<System1Runtime | undefined> {
  try {
    if (!system1Enabled(settings)) return undefined
    if (!(await readState())) return undefined
    const cache = await caches.open(CACHE_NAME)
    const manifest = await loadCachedManifest(WEIGHTS_PIN, cache)
    if (!manifest || !(await verifyCached(WEIGHTS_PIN, manifest, cache))) return undefined
    if (!(await hasWebGpu())) return undefined
    const engine = getSystem1Engine()
    if (!engine.healthy) return undefined
    return { decide: (req) => engine.decide(req) }
  } catch {
    return undefined
  }
}
