import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { ProviderConfig } from '../data/settings'

// Minimal chrome.storage.local stub backed by a plain object — the repo's
// established per-file pattern (see src/data/settingsStorage.test.ts).
function stubChromeStorage(): Record<string, unknown> {
  const store: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items)
        }),
      },
    },
  })
  return store
}

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
  raw: undefined,
}

/** A valid LanguageModelV3 doGenerate result whose only text part is `text`. */
function textResult(text: string): any {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: USAGE,
    warnings: [],
  }
}

// Per-modelId behavior registry the mocked createModel's doGenerate reads from,
// so each test controls exactly what "the model" replies without a DI refactor
// of ensureVisionCapability itself (mirrors agent.test.ts's approach of mocking
// at the model layer rather than injecting a probe function).
const behaviors: Record<string, () => Promise<any>> = {}

vi.mock('./provider', () => ({
  createModel: (_provider: unknown, modelId: string) =>
    new MockLanguageModelV3({
      doGenerate: async () => {
        const behavior = behaviors[modelId]
        if (!behavior) throw new Error(`vision.test.ts: no behavior registered for ${modelId}`)
        return behavior()
      },
    }),
  // vision.ts also pulls the observability-race fix (d14 F12) through this
  // module; undefined makes getObserver() fall back to its own disabled
  // default, which is all these capability-caching tests care about.
  currentObservabilityConfig: async () => undefined,
}))

import { ensureVisionCapability } from './vision'

// jsdom doesn't implement a real 2D canvas context without the native `canvas`
// npm package — makeProbeImage's getContext('2d') call returns null, so
// fillRect/fillText/etc. would throw before generateText is ever reached.
// Stubbed once for the whole file: only the probe's IMAGE bytes are faked,
// never the model reply that decides capable/not-capable.
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
  fillRect: () => {},
  fillText: () => {},
} as unknown as CanvasRenderingContext2D)
vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,ZmFrZQ==')

const PROVIDER: ProviderConfig = {
  id: 'p1',
  name: 'Ollama',
  baseURL: 'http://localhost:11434/v1',
  apiKey: '',
  kind: 'ollama',
  models: [],
}

let store: Record<string, unknown>

beforeEach(() => {
  store = stubChromeStorage()
  for (const k of Object.keys(behaviors)) delete behaviors[k]
})

describe('ensureVisionCapability: a probe that fails to run is never cached (d01 F2)', () => {
  it('a probe that throws is not cached, and is retried on the next call', async () => {
    let calls = 0
    behaviors['llava'] = async () => {
      calls++
      if (calls === 1) throw new Error('ETIMEDOUT: cold local model exceeded the probe window')
      return textResult('K7QX')
    }

    // First call: the probe itself fails (simulates a cold local model blowing
    // the timeout). Must report "not capable" for THIS call...
    const first = await ensureVisionCapability(PROVIDER, 'llava')
    expect(first).toBe(false)
    expect(calls).toBe(1)

    // ...but must NOT poison the cache — the very next call (e.g. the next
    // attachment, once the model has finished loading) re-probes and can
    // recover, with no manual reset and no wiping of chrome.storage.local.
    const second = await ensureVisionCapability(PROVIDER, 'llava')
    expect(second).toBe(true)
    expect(calls).toBe(2)
  })

  it('a probe that completes and genuinely says no IS cached (not a blanket "never cache false")', async () => {
    let calls = 0
    behaviors['gpt-4o-mini'] = async () => {
      calls++
      return textResult('wrong answer')
    }

    const first = await ensureVisionCapability(PROVIDER, 'gpt-4o-mini')
    expect(first).toBe(false)
    const second = await ensureVisionCapability(PROVIDER, 'gpt-4o-mini')
    expect(second).toBe(false)
    // The second call was served from cache — a genuine negative result (the
    // probe ran to completion and the model got it wrong) is still cached, so
    // a real "this model can't see" verdict doesn't re-probe forever either.
    expect(calls).toBe(1)
  })

  it('a probe that completes and succeeds is cached as capable', async () => {
    let calls = 0
    behaviors['gpt-4o'] = async () => {
      calls++
      return textResult('K7QX')
    }
    expect(await ensureVisionCapability(PROVIDER, 'gpt-4o')).toBe(true)
    expect(await ensureVisionCapability(PROVIDER, 'gpt-4o')).toBe(true)
    expect(calls).toBe(1)
  })
})

describe('ensureVisionCapability: concurrent probes for different keys do not lose one another (d01 F4)', () => {
  it('two probes started concurrently both end up persisted', async () => {
    let releaseA: (() => void) | undefined
    let releaseB: (() => void) | undefined
    const gateA = new Promise<void>((res) => {
      releaseA = res
    })
    const gateB = new Promise<void>((res) => {
      releaseB = res
    })

    // Both behaviors block on their own gate, so both ensureVisionCapability
    // calls are genuinely in flight (each has already taken its own initial
    // snapshot of the empty cache) before either finishes and writes.
    behaviors['model-a'] = async () => {
      await gateA
      return textResult('K7QX')
    }
    behaviors['model-b'] = async () => {
      await gateB
      return textResult('K7QX')
    }

    const pA = ensureVisionCapability(PROVIDER, 'model-a')
    const pB = ensureVisionCapability(PROVIDER, 'model-b')
    releaseA?.()
    releaseB?.()
    await Promise.all([pA, pB])

    // A lost-update race (each call read-modify-writes the whole shared
    // object from its own stale snapshot) would have whichever write landed
    // last silently drop the other key entirely.
    const cache = store['visionProbe'] as Record<string, boolean>
    expect(cache[`${PROVIDER.id}::model-a`]).toBe(true)
    expect(cache[`${PROVIDER.id}::model-b`]).toBe(true)
  })
})
