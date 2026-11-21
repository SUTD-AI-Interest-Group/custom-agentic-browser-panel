import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LanguageModel } from 'ai'

// The one model call profileLookup makes. Mocked so each test controls the answer and counts calls.
vi.mock('../agent/extract', () => ({ extractStructured: vi.fn() }))

import { extractStructured } from '../agent/extract'
import type { MemoryRecord } from '../data/memory'
import { clearProfileLookupCache, profileLookup } from './profileLookup'

const MODEL = { modelId: 'test-model' } as unknown as LanguageModel

const memory = (id: string, content: string, updatedAt = 1000): MemoryRecord => ({
  id, kind: 'profile', content, tags: ['profile'], createdAt: 1000, updatedAt, lastRecalledAt: null, recallCount: 0, source: 'user',
})

const MEMORIES = [
  memory('m1', "The user's full name is Ada Lovelace."),
  memory('m2', "The user's email address is ada@example.com."),
  memory('m3', "The user's home address is 12 St James’s Square, London SW1Y 4JH, United Kingdom."),
]

const ANSWER = {
  fields: [
    { key: 'full_name', value: 'Ada Lovelace' },
    { key: 'email', value: 'ada@example.com' },
    { key: 'city', value: 'London' },
  ],
}

beforeEach(() => {
  clearProfileLookupCache()
  vi.mocked(extractStructured).mockReset()
  vi.mocked(extractStructured).mockResolvedValue(ANSWER)
})

describe('profileLookup', () => {
  it('makes one structured call over the profile sentences and returns key → value', async () => {
    const out = await profileLookup(MODEL, MEMORIES)
    expect(out).toEqual({ full_name: 'Ada Lovelace', email: 'ada@example.com', city: 'London' })
    expect(extractStructured).toHaveBeenCalledTimes(1)
    const [model, prompt, schema] = vi.mocked(extractStructured).mock.calls[0]
    expect(model).toBe(MODEL)
    expect(schema).toEqual({
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] },
        },
      },
      required: ['fields'],
    })
    expect(prompt).toContain('snake_case')
    expect(prompt).toMatch(/exactly as written/i)
    expect(prompt).toMatch(/invent/i)
    for (const m of MEMORIES) expect(prompt).toContain(m.content)
  })

  it('hits the cache on identical memories: one model call for two lookups', async () => {
    const a = await profileLookup(MODEL, MEMORIES)
    const b = await profileLookup(MODEL, [...MEMORIES].reverse()) // same set, different order
    expect(b).toEqual(a)
    expect(extractStructured).toHaveBeenCalledTimes(1)
  })

  it('shares one call between two concurrent lookups of the same memories', async () => {
    const [a, b] = await Promise.all([profileLookup(MODEL, MEMORIES), profileLookup(MODEL, MEMORIES)])
    expect(a).toEqual(b)
    expect(extractStructured).toHaveBeenCalledTimes(1)
  })

  it('misses after a memory’s updatedAt changes', async () => {
    await profileLookup(MODEL, MEMORIES)
    const edited = [MEMORIES[0], { ...MEMORIES[1], updatedAt: 2000 }, MEMORIES[2]]
    await profileLookup(MODEL, edited)
    expect(extractStructured).toHaveBeenCalledTimes(2)
  })

  it('hands back a copy: a caller mutating its result cannot poison the cache', async () => {
    const a = await profileLookup(MODEL, MEMORIES)
    a.email = 'mallory@example.com'
    expect((await profileLookup(MODEL, MEMORIES)).email).toBe('ada@example.com')
  })

  it('drops a value that appears in no profile sentence — nothing invented reaches a form', async () => {
    vi.mocked(extractStructured).mockResolvedValue({
      fields: [
        { key: 'full_name', value: 'Ada Lovelace' },
        { key: 'phone', value: '+44 20 0000 0000' }, // invented
        { key: 'street', value: "12 St James's Square" }, // straight quote vs the memory's curly one: same text
      ],
    })
    expect(await profileLookup(MODEL, MEMORIES)).toEqual({ full_name: 'Ada Lovelace', street: "12 St James's Square" })
  })

  it('normalises keys to snake_case, and skips empty, duplicate and malformed entries', async () => {
    vi.mocked(extractStructured).mockResolvedValue({
      fields: [
        { key: 'Full Name', value: 'Ada Lovelace' },
        { key: 'full-name', value: 'Ada' }, // the same key again: first wins
        { key: '', value: 'London' },
        { key: 'city', value: '   ' },
        { key: 'email', value: 42 },
        'not an object',
        { key: 'E-mail Address', value: ' ada@example.com ' },
      ],
    })
    expect(await profileLookup(MODEL, MEMORIES)).toEqual({ full_name: 'Ada Lovelace', e_mail_address: 'ada@example.com' })
  })

  it('makes no call for zero memories', async () => {
    expect(await profileLookup(MODEL, [])).toEqual({})
    expect(extractStructured).not.toHaveBeenCalled()
  })

  it('rejects when the model call fails — and does not cache the failure', async () => {
    vi.mocked(extractStructured).mockRejectedValueOnce(new Error('HTTP 500'))
    await expect(profileLookup(MODEL, MEMORIES)).rejects.toThrow('HTTP 500')
    expect(await profileLookup(MODEL, MEMORIES)).toEqual({ full_name: 'Ada Lovelace', email: 'ada@example.com', city: 'London' })
    expect(extractStructured).toHaveBeenCalledTimes(2)
  })

  it('rejects an answer that is not the schema’s shape', async () => {
    vi.mocked(extractStructured).mockResolvedValue({ nope: true })
    await expect(profileLookup(MODEL, MEMORIES)).rejects.toThrow(/profile/i)
  })

  it('passes the abort signal through', async () => {
    const signal = new AbortController().signal
    await profileLookup(MODEL, MEMORIES, signal)
    expect(vi.mocked(extractStructured).mock.calls[0][3]).toBe(signal)
  })
})
