// Whether this chain gets an Act tool at all: toggle on, weights ready for the
// pinned revision and present in the cache, a WebGPU adapter with the fp16
// graph's required feature, and an engine that has not failed. Any "no" →
// undefined → the tool is never built.
import type { Settings } from '../data/settings'
import { system1Enabled } from '../data/settings'
import { getSystem1Engine } from './engine'
import type { DecideRequest, DecideResult } from './protocol'
import { CACHE_NAME, WEIGHTS_PIN, loadCachedManifest, readState, verifyCached } from './weights'

export interface System1Runtime {
  decide(req: DecideRequest): Promise<DecideResult>
  /**
   * Start booting the engine now (fire-and-forget), so the 1.2–6 s cold boot
   * — measured inside the first `Act` call of every panel load on 2026-09-27 —
   * is paid while the page-control grant is being read, not inside the call.
   */
  warm(): void
}

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

// Cached per requireF16 value, not shared: which manifest is currently cached
// can change (a re-download could swap variants), and "is there any adapter"
// and "is there an adapter with shader-f16" are two different facts that
// don't invalidate each other.
const adapterProbes = new Map<boolean, Promise<boolean>>()

/**
 * True when a WebGPU adapter exists, and — only when `requireF16` is set —
 * that adapter also advertises `shader-f16`. Not every shipped variant needs
 * the feature: the fp16 graph does, but a weight-only quantized graph with
 * fp32 activations does not (see the manifest's `requiresShaderF16`), so the
 * caller decides per the manifest it actually resolved, rather than this
 * function assuming one graph shape. Cached for the life of the context: an
 * adapter's feature set cannot change without a context reload, same
 * rationale as `pageAccess.ts`'s `fileAccessGranted()` cache.
 */
export function hasWebGpu(requireF16: boolean): Promise<boolean> {
  let probe = adapterProbes.get(requireF16)
  if (!probe) {
    const gpu = (navigator as Navigator & { gpu?: MinimalGpu }).gpu
    probe = gpu
      ? gpu.requestAdapter().then((a) => a != null && (!requireF16 || a.features.has('shader-f16')), () => false)
      : Promise.resolve(false)
    adapterProbes.set(requireF16, probe)
  }
  return probe
}

export async function resolveSystem1(settings: Settings): Promise<System1Runtime | undefined> {
  try {
    if (!system1Enabled(settings)) return undefined
    if (!(await readState())) return undefined
    const cache = await caches.open(CACHE_NAME)
    const manifest = await loadCachedManifest(WEIGHTS_PIN, cache)
    if (!manifest || !(await verifyCached(WEIGHTS_PIN, manifest, cache))) return undefined
    if (!(await hasWebGpu(manifest.requiresShaderF16 === true))) return undefined
    const engine = getSystem1Engine()
    if (!engine.healthy) return undefined
    return { decide: (req) => engine.decide(req), warm: () => void engine.warm() }
  } catch {
    return undefined
  }
}
