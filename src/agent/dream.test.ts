import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateText } from 'ai'
import { createModel } from './provider'
import {
  appendToEpisode,
  clearMemory,
  getDreamState,
  listMemories,
  listUnconsolidatedEpisodes,
  setDreamState,
  type EpisodeMessage,
  type EpisodeRecord,
} from '../data/memory'
import { defaultSettings, loadSettings, type Settings } from '../data/settings'

// dream.ts had ZERO test coverage before this file. Strategy mirrors
// research.test.ts: mock the expensive/Chrome-adjacent collaborators
// (generateText, createModel, loadSettings) so tests control the model's
// output directly, and exercise real chrome.storage.local (a plain-object
// stub, this repo's established pattern) + real IndexedDB (fake-indexeddb)
// for everything dream.ts actually needs to get right — the reentrancy lock
// and the memory/episode stores it guards.

vi.mock('./provider', () => ({ createModel: vi.fn(() => ({ modelId: 'mock-model' })) }))
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: vi.fn() }
})
vi.mock('../data/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/settings')>()
  return { ...actual, loadSettings: vi.fn() }
})

// Import AFTER the vi.mock calls above (vitest hoists them, so this is safe
// regardless of literal order, but writing it this way keeps intent obvious).
import {
  acquireDreamLock,
  buildDreamPrompt,
  dreamIfDue,
  evaluateDreamDue,
  MAX_MEMORY_CHARS,
  MAX_TRANSCRIPT_CHARS,
  parseDreamOps,
  releaseDreamLock,
  runDream,
} from './dream'

const mockedGenerateText = vi.mocked(generateText)
const mockedCreateModel = vi.mocked(createModel)
const mockedLoadSettings = vi.mocked(loadSettings)

// Minimal chrome.storage.local stub backed by a plain object — this repo's
// established per-file pattern (see settingsStorage.test.ts).
function stubChromeStorage(): Record<string, unknown> {
  const store: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items)
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key]
        }),
      },
    },
  })
  return store
}

function withProvider(): Settings {
  const s = defaultSettings()
  s.providers = [
    { id: 'p1', name: 'Test', baseURL: 'https://api.test.invalid/v1', apiKey: 'sk-test', models: ['m1'], kind: 'custom' },
  ]
  s.selected = { providerId: 'p1', modelId: 'm1' }
  s.onboarded = true
  return s
}

function msg(text: string, role: EpisodeMessage['role'] = 'user'): EpisodeMessage {
  return { role, text, at: Date.now() }
}

function opsJson(over: { add?: unknown[]; update?: unknown[]; delete?: string[]; daySummary?: string | null } = {}): string {
  return JSON.stringify({ add: [], update: [], delete: [], daySummary: null, ...over })
}

beforeEach(async () => {
  vi.resetAllMocks()
  stubChromeStorage()
  await clearMemory()
  mockedCreateModel.mockReturnValue({ modelId: 'mock-model' } as never)
})

describe('evaluateDreamDue', () => {
  const HOUR = 60 * 60 * 1000
  const episode = (updatedAt: number): Pick<EpisodeRecord, 'updatedAt'> => ({ updatedAt })

  it('is due on a fresh install (no lastDreamAt) once episodes exist and are idle long enough', () => {
    const now = 10 * HOUR
    const result = evaluateDreamDue({ lastDreamAt: null, episodes: [episode(now - 31 * 60 * 1000)], intervalMs: HOUR, now })
    expect(result).toEqual({ due: true })
  })

  it('is not due with no episodes at all, even on a fresh install', () => {
    const result = evaluateDreamDue({ lastDreamAt: null, episodes: [], intervalMs: HOUR, now: 0 })
    expect(result).toEqual({ due: false, reason: 'Nothing new to consolidate.' })
  })

  it('is not due before the interval has elapsed', () => {
    const now = 10 * HOUR
    const result = evaluateDreamDue({
      lastDreamAt: now - HOUR + 1,
      episodes: [episode(now - 40 * 60 * 1000)],
      intervalMs: HOUR,
      now,
    })
    expect(result).toEqual({ due: false, reason: 'Dreamed recently.' })
  })

  it('is due exactly AT the interval boundary (not just strictly past it)', () => {
    const now = 10 * HOUR
    const result = evaluateDreamDue({ lastDreamAt: now - HOUR, episodes: [episode(now - 40 * 60 * 1000)], intervalMs: HOUR, now })
    expect(result).toEqual({ due: true })
  })

  it('is not due while the user is still active (idle guard), even past the interval', () => {
    const now = 10 * HOUR
    const result = evaluateDreamDue({
      lastDreamAt: now - 2 * HOUR,
      episodes: [episode(now - 10 * 60 * 1000)],
      intervalMs: HOUR,
      now,
    })
    expect(result).toEqual({ due: false, reason: 'User is still active.' })
  })

  it('is due exactly AT the 30-minute idle boundary', () => {
    const now = 10 * HOUR
    const result = evaluateDreamDue({ lastDreamAt: null, episodes: [episode(now - 30 * 60 * 1000)], intervalMs: HOUR, now })
    expect(result).toEqual({ due: true })
  })

  it('treats a lastDreamAt far in the future (clock skew) as if it were unset, rather than blocking forever', () => {
    const now = 10 * HOUR
    const result = evaluateDreamDue({
      lastDreamAt: now + 2 * HOUR,
      episodes: [episode(now - 40 * 60 * 1000)],
      intervalMs: HOUR,
      now,
    })
    expect(result).toEqual({ due: true })
  })

  it('a lastDreamAt only slightly ahead (within tolerance) is still a real recent dream, not clock skew', () => {
    const now = 10 * HOUR
    const result = evaluateDreamDue({
      lastDreamAt: now + 10_000,
      episodes: [episode(now - 40 * 60 * 1000)],
      intervalMs: HOUR,
      now,
    })
    expect(result).toEqual({ due: false, reason: 'Dreamed recently.' })
  })

  it('an interval of 0 never blocks (falls straight through to the episode/idle checks)', () => {
    const now = 10 * HOUR
    const result = evaluateDreamDue({ lastDreamAt: now, episodes: [episode(now - 40 * 60 * 1000)], intervalMs: 0, now })
    expect(result).toEqual({ due: true })
  })

  it('an enormous interval blocks indefinitely without crashing (the user\'s own explicit choice)', () => {
    const now = 10 * HOUR
    const result = evaluateDreamDue({
      lastDreamAt: now - HOUR,
      episodes: [episode(now - 40 * 60 * 1000)],
      intervalMs: Number.MAX_SAFE_INTEGER,
      now,
    })
    expect(result).toEqual({ due: false, reason: 'Dreamed recently.' })
  })

  it('finds the true max updatedAt across a very large episode array without a stack-overflowing spread', () => {
    const now = 10 * HOUR
    const episodes = Array.from({ length: 200_000 }, (_, i) => episode(i)) // max updatedAt = 199_999, far in the past
    expect(() => evaluateDreamDue({ lastDreamAt: null, episodes, intervalMs: HOUR, now })).not.toThrow()
    expect(evaluateDreamDue({ lastDreamAt: null, episodes, intervalMs: HOUR, now })).toEqual({ due: true })
  })
})

describe('runDream reentrancy', () => {
  it('two overlapping runDream() calls only consolidate once — no memory is lost or duplicated', async () => {
    await appendToEpisode('ep1', [msg('hi')])

    let releaseFirst!: (value: { text: string; usage: Record<string, never> }) => void
    const firstCallEntered = new Promise<void>((resolveEntered) => {
      mockedGenerateText.mockImplementationOnce(() => {
        resolveEntered()
        return new Promise((resolve) => {
          releaseFirst = resolve as never
        })
      })
    })
    // Queued so that IF the mutex fails and a second call reaches generateText,
    // it gets a distinguishable (wrong) payload rather than reusing the first's.
    mockedGenerateText.mockResolvedValueOnce({
      text: opsJson({ add: [{ kind: 'fact', content: 'second call must not run', tags: [] }] }),
      usage: {},
    } as never)

    const settings = withProvider()
    const p1 = runDream(settings)
    await firstCallEntered // p1 now holds the lock and is blocked "generating"
    const p2 = runDream(settings) // must see the lock held and skip immediately

    const r2 = await p2
    expect(r2).toEqual({ status: 'skipped', reason: 'Another dream cycle is already in progress.' })

    releaseFirst({
      text: opsJson({ add: [{ kind: 'fact', content: 'first call memory', tags: [] }] }),
      usage: {},
    })
    const r1 = await p1
    expect(r1.status).toBe('dreamed')

    expect(mockedGenerateText).toHaveBeenCalledTimes(1)
    const memories = await listMemories()
    expect(memories.map((m) => m.content)).toEqual(['first call memory'])
    expect(await listUnconsolidatedEpisodes()).toEqual([])
  })

  it('a released lock lets the next runDream() through immediately', async () => {
    await appendToEpisode('ep1', [msg('hi')])
    mockedGenerateText.mockResolvedValueOnce({ text: opsJson({}), usage: {} } as never)
    const r1 = await runDream(withProvider())
    expect(r1.status).toBe('dreamed')

    await appendToEpisode('ep2', [msg('again')])
    mockedGenerateText.mockResolvedValueOnce({ text: opsJson({}), usage: {} } as never)
    const r2 = await runDream(withProvider())
    expect(r2.status).toBe('dreamed')
  })
})

describe('dream lock (acquireDreamLock/releaseDreamLock)', () => {
  it('a second acquire fails while the first is fresh, and releasing lets a new one in', async () => {
    const t1 = await acquireDreamLock()
    expect(t1).not.toBeNull()
    expect(await acquireDreamLock()).toBeNull()
    await releaseDreamLock(t1!)
    const t2 = await acquireDreamLock()
    expect(t2).not.toBeNull()
    expect(t2).not.toBe(t1)
  })

  it('a lock older than the TTL is treated as abandoned (the holder crashed mid-dream) and can be reclaimed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(0)
      const t1 = await acquireDreamLock()
      expect(t1).not.toBeNull()
      // Advance past the TTL without ever releasing — simulates the service
      // worker being killed mid-dream (MV3's whole premise) before its
      // `finally` runs.
      vi.setSystemTime(6 * 60 * 1000)
      const t2 = await acquireDreamLock()
      expect(t2).not.toBeNull()
      expect(t2).not.toBe(t1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a lock timestamped implausibly far in the future (clock skew) is treated as stale, not freshly held', async () => {
    const { setDreamLock } = await import('../data/memory')
    await setDreamLock({ token: 'skewed', acquiredAt: Date.now() + 60 * 60 * 1000 })
    expect(await acquireDreamLock()).not.toBeNull()
  })

  it('release is a no-op once the lock has already been reclaimed by someone else', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(0)
      const t1 = await acquireDreamLock()
      vi.setSystemTime(6 * 60 * 1000)
      const t2 = await acquireDreamLock() // reclaims the abandoned lock
      expect(t2).not.toBeNull()
      // t1's holder finally wakes up and releases its (now-stolen) token —
      // must not tear out t2's live lock.
      await releaseDreamLock(t1!)
      const { getDreamLock } = await import('../data/memory')
      expect(await getDreamLock()).toEqual({ token: t2, acquiredAt: 6 * 60 * 1000 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('is durable across a simulated module reload — not an in-memory flag that would reset when the service worker restarts', async () => {
    const token = await acquireDreamLock()
    expect(token).not.toBeNull()

    vi.resetModules()
    const reloaded = await import('./dream')
    // A brand-new module instance (everything module-scoped starts fresh,
    // exactly as it would after the service worker is killed and restarted)
    // still sees the lock as held, because it lives in chrome.storage.local,
    // not in a variable a fresh import would reset.
    expect(await reloaded.acquireDreamLock()).toBeNull()
  })
})

describe('runDream bypasses the gates dreamIfDue enforces ("Dream now")', () => {
  it('runs immediately even when dreamIfDue would say "Dreamed recently" or "User is still active"', async () => {
    await appendToEpisode('ep1', [msg('just now')]) // not idle by dreamIfDue's standard
    await setDreamState({ lastDreamAt: Date.now(), lastSummary: null, consecutiveParseFailures: 0 }) // "just dreamed"
    mockedGenerateText.mockResolvedValueOnce({ text: opsJson({ daySummary: 'ok' }), usage: {} } as never)

    const result = await runDream(withProvider()) // direct call — the "Dream now" path
    expect(result.status).toBe('dreamed')
  })

  it('contrast: dreamIfDue would have skipped under the same conditions', async () => {
    await appendToEpisode('ep1', [msg('just now')])
    await setDreamState({ lastDreamAt: Date.now(), lastSummary: null, consecutiveParseFailures: 0 })
    mockedLoadSettings.mockResolvedValue(withProvider())

    const result = await dreamIfDue()
    expect(result).toEqual({ status: 'skipped', reason: 'Dreamed recently.' })
    expect(mockedGenerateText).not.toHaveBeenCalled()
  })
})

describe('dreamIfDue wiring', () => {
  it('delegates to runDream and reports a real dream once due', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(0)
      await appendToEpisode('ep1', [msg('hi')])
      vi.setSystemTime(31 * 60 * 1000) // past the 30-minute idle guard
      mockedLoadSettings.mockResolvedValue(withProvider())
      mockedGenerateText.mockResolvedValueOnce({ text: opsJson({}), usage: {} } as never)

      const result = await dreamIfDue()
      expect(result.status).toBe('dreamed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips without ever calling the model when nothing is pending', async () => {
    mockedLoadSettings.mockResolvedValue(defaultSettings())
    const result = await dreamIfDue()
    expect(result).toEqual({ status: 'skipped', reason: 'Nothing new to consolidate.' })
    expect(mockedGenerateText).not.toHaveBeenCalled()
  })
})

describe('consecutive parse failures', () => {
  it('increments a counter on unparseable output, surfaces a louder message past the threshold, and resets it on success', async () => {
    await appendToEpisode('ep1', [msg('hi')])

    mockedGenerateText.mockResolvedValueOnce({ text: 'not json at all', usage: {} } as never)
    const r1 = await runDream(withProvider())
    expect(r1).toEqual({ status: 'skipped', reason: 'Model returned unparseable output; will retry next cycle.' })
    expect((await getDreamState()).consecutiveParseFailures).toBe(1)

    mockedGenerateText.mockResolvedValueOnce({ text: 'still not json', usage: {} } as never)
    await runDream(withProvider())
    expect((await getDreamState()).consecutiveParseFailures).toBe(2)

    // PARSE_FAILURE_WARNING_THRESHOLD is 3.
    mockedGenerateText.mockResolvedValueOnce({ text: 'nope', usage: {} } as never)
    const r3 = await runDream(withProvider())
    expect((await getDreamState()).consecutiveParseFailures).toBe(3)
    if (r3.status === 'skipped') expect(r3.reason).toContain('3 times in a row')

    // Episode is still pending (parse failures never consolidate) — a
    // successful parse now both consolidates it and resets the counter.
    mockedGenerateText.mockResolvedValueOnce({ text: opsJson({ daySummary: 'finally' }), usage: {} } as never)
    const r4 = await runDream(withProvider())
    expect(r4.status).toBe('dreamed')
    expect((await getDreamState()).consecutiveParseFailures).toBe(0)
    expect(await listUnconsolidatedEpisodes()).toEqual([])
  })
})

describe('episode cap (oldest-first, bounded per cycle)', () => {
  it('caps how many unconsolidated episodes one cycle consolidates, oldest first, leaving overflow for next time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      for (let i = 0; i < 501; i++) {
        vi.setSystemTime(i)
        await appendToEpisode(`ep-${i}`, [msg(`m${i}`)])
      }
      mockedGenerateText.mockResolvedValueOnce({ text: opsJson({}), usage: {} } as never)
      const result = await runDream(withProvider())
      expect(result.status).toBe('dreamed')
      if (result.status === 'dreamed') expect(result.episodes).toBe(500) // MAX_EPISODES_PER_DREAM
      const remaining = await listUnconsolidatedEpisodes()
      expect(remaining.map((e) => e.id)).toEqual(['ep-500']) // newest, left for the next cycle
    } finally {
      vi.useRealTimers()
    }
  }, 20_000)
})

describe('buildDreamPrompt', () => {
  it('truncates a single oversized episode block to the remaining budget instead of overshooting MAX_TRANSCRIPT_CHARS', () => {
    // 300 messages ~1000 chars each — one episode (a power-user's long,
    // many-turn session) alone totals far more than the whole budget.
    const messages: EpisodeMessage[] = Array.from({ length: 300 }, (_, i) => ({
      role: 'user',
      text: `msg-${i} ${'y'.repeat(1000)}`,
      at: i,
    }))
    const episodes: EpisodeRecord[] = [{ id: 'huge', startedAt: 0, updatedAt: 0, consolidated: false, messages }]
    const prompt = buildDreamPrompt([], episodes)
    // A naive whole-block append would produce 300_000+ chars; the fix keeps
    // the total within the budget plus a small, bounded scaffold/ellipsis slop.
    expect(prompt.length).toBeLessThan(MAX_TRANSCRIPT_CHARS + 2_000)
  })

  it('includes short episodes in full and notes how many older ones were omitted', () => {
    const episodes: EpisodeRecord[] = [
      { id: 'e1', startedAt: 0, updatedAt: 0, consolidated: false, messages: [{ role: 'user', text: 'hello', at: 0 }] },
    ]
    const prompt = buildDreamPrompt([], episodes)
    expect(prompt).toContain('hello')
    expect(prompt).not.toContain('omitted for length')
  })
})

describe('parseDreamOps', () => {
  it('parses a valid response, clamping unknown/summary kinds to fact and dropping non-string deletes', () => {
    const ops = parseDreamOps(
      JSON.stringify({
        add: [
          { kind: 'preference', content: ' likes dark mode ', tags: [' UI ', 'ui'] },
          { kind: 'summary', content: 'sneaky summary via add', tags: [] },
          { kind: 'bogus', content: 'unknown kind', tags: [] },
        ],
        update: [{ id: 'm1', content: 'revised', tags: ['x'] }],
        delete: ['m2', 42, null],
        daySummary: '  worked on the memory audit  ',
      }),
    )
    expect(ops).not.toBeNull()
    expect(ops!.add.map((a) => a.kind)).toEqual(['preference', 'fact', 'fact'])
    expect(ops!.add[0].content).toBe('likes dark mode')
    expect(ops!.update).toEqual([{ id: 'm1', patch: { content: 'revised', tags: ['x'] } }])
    expect(ops!.delete).toEqual(['m2'])
    expect(ops!.daySummary).toBe('worked on the memory audit')
  })

  it('returns null for text with no JSON object at all, or malformed JSON', () => {
    expect(parseDreamOps('no json here')).toBeNull()
    expect(parseDreamOps('{ this is not : valid json')).toBeNull()
  })

  it('tolerates surrounding prose/markdown fences around the JSON object', () => {
    const ops = parseDreamOps('Sure! Here you go:\n```json\n{"add":[],"update":[],"delete":[],"daySummary":null}\n```')
    expect(ops).toEqual({ add: [], update: [], delete: [], daySummary: null })
  })

  it('drops an add/update entry with missing or blank content (update needs SOME field to patch)', () => {
    const ops = parseDreamOps(
      JSON.stringify({
        add: [{ kind: 'fact', content: '   ' }, { kind: 'fact' }],
        update: [{ id: 'm1' }, { id: 'm1', content: '  ' }],
        delete: [],
        daySummary: null,
      }),
    )
    expect(ops!.add).toEqual([])
    expect(ops!.update).toEqual([])
  })

  it('caps content/daySummary length', () => {
    const longText = 'z'.repeat(2000)
    const ops = parseDreamOps(
      JSON.stringify({ add: [{ kind: 'fact', content: longText, tags: [] }], update: [], delete: [], daySummary: longText }),
    )
    expect(ops!.add[0].content.length).toBe(MAX_MEMORY_CHARS)
    expect(ops!.daySummary!.length).toBe(MAX_MEMORY_CHARS * 2)
  })
})
