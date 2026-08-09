import { expect, test } from 'vitest'
import { normalizeHost, parseFraming } from './researchFraming'

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
