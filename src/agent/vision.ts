// Runtime one-shot probe: does the selected model actually read images? Cached
// per provider+model in chrome.storage.local. We render a small image holding a
// random code and check the model echoes it back — this also catches endpoints
// that silently ignore image parts (they won't return the code).

import { generateText } from 'ai'
import { createModel } from './provider'
import type { ProviderConfig } from '../data/settings'

const CACHE_KEY = 'visionProbe'

async function readCache(): Promise<Record<string, boolean>> {
  const data = await chrome.storage.local.get(CACHE_KEY)
  return (data[CACHE_KEY] as Record<string, boolean>) ?? {}
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
  let capable = false
  try {
    const { text } = await generateText({
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
  } catch {
    capable = false
  }
  cache[key] = capable
  await chrome.storage.local.set({ [CACHE_KEY]: cache })
  return capable
}
