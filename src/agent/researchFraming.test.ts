import { beforeEach, expect, test, vi } from 'vitest'

// frameResearch's abort-signal contract (fresh per-attempt timeout vs a reused
// caller signal) had no coverage. Mock only generateObject/generateText from
// 'ai' — everything else (jsonSchema, types) rides through the real module.
// Same pattern as extract.test.ts.
const generateObjectMock = vi.fn()
const generateTextMock = vi.fn()

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    generateObject: (...args: unknown[]) => generateObjectMock(...args),
    generateText: (...args: unknown[]) => generateTextMock(...args),
  }
})

import { frameResearch, normalizeHost, parseFraming, type FrameResearchOpts } from './researchFraming'

const MODEL = {} as FrameResearchOpts['model']

beforeEach(() => {
  generateObjectMock.mockReset()
  generateTextMock.mockReset()
})

const RAW = {
  question: 'Compare the specs of the 4 Aftershock prebuilt configs',
  brief: 'The overview page lists 4 configs; product pages hold the spec sheets.',
  subQuestions: ['CPU / GPU per config', 'RAM & storage'],
  sites: ['https://www.aftershockpc.com/pc/apex'],
  premise: { asserted: '5 setups', corrected: '4 setups' },
  clarifications: ['Budget range?'],
}

test('passes a well-formed object through, normalizing sites to hosts', () => {
  const r = parseFraming(RAW, 'fallback')
  expect(r.question).toBe('Compare the specs of the 4 Aftershock prebuilt configs')
  expect(r.sites).toEqual(['aftershockpc.com'])
  expect(r.premise).toEqual({ asserted: '5 setups', corrected: '4 setups' })
})

test('parses JSON out of a string, past a think block and a preamble', () => {
  const raw = `<think>the user said five</think>\nSure! Here you go:\n${JSON.stringify(RAW)}`
  expect(parseFraming(raw, 'fallback').question).toBe(RAW.question)
})

test('unwraps a quoted question', () => {
  expect(parseFraming({ question: '"Compare the configs"' }, 'fb').question).toBe('Compare the configs')
})

test('truncates clarifications to two', () => {
  const r = parseFraming({ question: 'q', clarifications: ['a', 'b', 'c'] }, 'fb')
  expect(r.clarifications).toEqual(['a', 'b'])
})

test('drops a premise missing either half', () => {
  expect(parseFraming({ question: 'q', premise: { asserted: '5' } }, 'fb').premise).toBeUndefined()
})

test('unusable output falls back to the raw message with no premise and no scope', () => {
  const r = parseFraming('not json at all', 'compare the setups')
  expect(r).toEqual({ question: 'compare the setups', subQuestions: [], sites: [] })
})

test('normalizeHost strips scheme, path, port and a leading www', () => {
  expect(normalizeHost('https://www.aftershockpc.com:443/pc/x')).toBe('aftershockpc.com')
  expect(normalizeHost('aftershockpc.com')).toBe('aftershockpc.com')
  expect(normalizeHost('   ')).toBeNull()
})

test('the schema requires only a question', () => {
  // Guards the contract frameResearch's fallbacks rely on: anything past
  // `question` is optional, so a partial model response still yields a proposal.
  expect(parseFraming({ question: 'q' }, 'fb')).toEqual({ question: 'q', subQuestions: [], sites: [] })
})

test('drops a dotless scope entry — a bare public suffix would restrict nothing', () => {
  // scopeAllows (browsePolicy.ts) suffix-matches a scope entry, so an entry with
  // no dot (e.g. the TLD 'com') would admit every host on the internet under it —
  // a launch-card chip that reads as "pinned to one site" while pinning nothing.
  expect(parseFraming({ question: 'q', sites: ['com', 'aftershockpc.com'] }, 'fb').sites).toEqual([
    'aftershockpc.com',
  ])
})

test('frameResearch: without a caller signal, the generateText fallback gets its own fresh timeout', async () => {
  // Regression pin: the original code computed ONE AbortSignal.timeout() and
  // reused that exact reference for both calls. AbortSignal.timeout() latches
  // aborted permanently once it fires, so if ITS firing is why generateObject
  // failed, generateText would see an already-aborted signal and reject before
  // reaching the network — collapsing the three-tier fallback to two in exactly
  // the timeout branch it exists to cover. A fresh instance per attempt (when
  // there is no caller signal to preserve) is what keeps the fallback able to
  // run at all. This does not reproduce the live-fetch-rejects-immediately part
  // (that needs a real network stack, not this mocked unit test) — it pins the
  // one thing a unit test can: the two calls must not share the SAME signal
  // object when opts.signal is absent.
  generateObjectMock.mockRejectedValue(new Error('the 20s ceiling fired'))
  generateTextMock.mockResolvedValue({ text: JSON.stringify({ question: 'q' }) })

  const result = await frameResearch({ model: MODEL, message: 'fallback q', context: '' })

  expect(result.question).toBe('q')
  const objectSignal = generateObjectMock.mock.calls[0][0].abortSignal
  const textSignal = generateTextMock.mock.calls[0][0].abortSignal
  expect(objectSignal).toBeInstanceOf(AbortSignal)
  expect(textSignal).toBeInstanceOf(AbortSignal)
  expect(textSignal).not.toBe(objectSignal)
})

test('frameResearch: a caller-supplied signal is reused as-is across both attempts', async () => {
  // The other half of the same contract: genuine user-driven cancellation must
  // keep covering the WHOLE call, not just the first attempt — a cancelled
  // framing should stop outright rather than quietly start a second request.
  generateObjectMock.mockRejectedValue(new Error('some non-abort failure'))
  generateTextMock.mockResolvedValue({ text: JSON.stringify({ question: 'q' }) })
  const controller = new AbortController()

  await frameResearch({ model: MODEL, message: 'fallback q', context: '', signal: controller.signal })

  const objectSignal = generateObjectMock.mock.calls[0][0].abortSignal
  const textSignal = generateTextMock.mock.calls[0][0].abortSignal
  expect(objectSignal).toBe(controller.signal)
  expect(textSignal).toBe(controller.signal)
})
