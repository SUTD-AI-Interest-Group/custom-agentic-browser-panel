// Runtime one-shot probe: does the selected model actually read images? Cached
// per provider+model in chrome.storage.local. We render a small image holding a
// random code and check the model echoes it back — this also catches endpoints
// that silently ignore image parts (they won't return the code).

import { generateText } from 'ai'
import { createModel, currentObservabilityConfig } from './provider'
import { getObserver } from './observability'
import type { ProviderConfig } from '../data/settings'

const CACHE_KEY = 'visionProbe'

async function readCache(): Promise<Record<string, boolean>> {
  const data = await chrome.storage.local.get(CACHE_KEY)
  return (data[CACHE_KEY] as Record<string, boolean>) ?? {}
}

/**
 * Serializes cache writes behind one shared chain so two probes for DIFFERENT
 * keys started close together (the chat model and a differently-configured
 * titleModel/dreamModel, both cold at once — plausible the first time a user
 * tries a new model) can't lose one another's result (d01 F4). Each call's own
 * merge re-reads storage immediately before writing, from inside the chain —
 * not from whatever snapshot `ensureVisionCapability` happened to read at
 * entry — so a write only ever loses to a write that was already superseded by
 * the time it ran, never to one that is still in flight.
 */
let writeChain: Promise<void> = Promise.resolve()
function writeCacheEntry(key: string, capable: boolean): Promise<void> {
  writeChain = writeChain
    // One write's failure (a storage quota error, say) must not wedge every
    // later probe's write behind a permanently-rejected chain.
    .catch(() => {})
    .then(async () => {
      const cache = await readCache()
      cache[key] = capable
      await chrome.storage.local.set({ [CACHE_KEY]: cache })
    })
  return writeChain
}

function makeProbeImage(code: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = 240
  canvas.height = 80
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 240, 80)
  ctx.fillStyle = '#000000'
  ctx.font = 'bold 48px monospace'
  ctx.fillText(code, 30, 56)
  return canvas.toDataURL('image/png')
}

/** True if the model reads images. Probes once, then serves from cache. */
export async function ensureVisionCapability(
  provider: ProviderConfig,
  modelId: string,
): Promise<boolean> {
  const key = `${provider.id}::${modelId}`
  const cache = await readCache()
  if (key in cache) return cache[key]
  // A fixed 4-char code; varying it is unnecessary and would defeat the cache.
  const code = 'K7QX'
  const observer = getObserver(await currentObservabilityConfig())
  const trace = observer.enabled
    ? observer.startTrace({ name: 'vision-probe', tags: ['vision'], metadata: { provider: provider.name } })
    : undefined
  const gen = trace?.generation({ name: 'vision-probe', model: modelId })
  let capable = false
  // Distinguish "the probe ran and proved a verdict" from "the probe itself
  // never completed" (network drop, provider 5xx, or simply a cold local
  // model's weight-load time exceeding the timeout below) — see the cache
  // write at the bottom (d01 F2).
  let probeCompleted = false
  try {
    const { text, usage } = await generateText({
      model: createModel(provider, modelId),
      messages: [
        {
          role: 'user',
          content: [
            // v7: use a `file` part with an image mediaType instead of the
            // deprecated `{ type: 'image', image }` part.
            { type: 'file', mediaType: 'image', data: makeProbeImage(code) },
            { type: 'text', text: 'Reply with ONLY the 4-character code shown in this image.' },
          ],
        },
      ],
      abortSignal: AbortSignal.timeout(20_000),
    })
    capable = text.toUpperCase().includes(code)
    probeCompleted = true
    gen?.end({ output: text, usage })
  } catch (err) {
    capable = false
    gen?.end({ level: 'ERROR', statusMessage: err instanceof Error ? err.message : String(err) })
  }
  trace?.end({ metadata: { capable, probeCompleted } })
  void observer.flush()
  // Only a probe that ran to completion is trustworthy enough to cache —
  // forever, with no TTL. Caching a probe that merely FAILED would be
  // indistinguishable from "the model looked and got it wrong": a vision-
  // capable local model whose first cold start exceeds the 20s timeout above
  // would then be permanently and silently routed down the blind
  // (text-extraction) path, with no way to recover short of wiping all of
  // chrome.storage.local (which also destroys every other setting). Leaving
  // the key unset means the very next call for this (provider, model) —
  // typically the next attachment or screenshot — retries, and only gets
  // cached once the model has actually answered.
  if (probeCompleted) {
    await writeCacheEntry(key, capable)
  }
  return capable
}
