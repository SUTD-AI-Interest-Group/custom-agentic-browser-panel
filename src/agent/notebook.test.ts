import { test, expect } from 'vitest'
import {
  createNotebook,
  emptyNotebook,
  djb2,
  normalizeUrl,
  credibilityHint,
  summarizeNotebook,
  isFullyCovered,
  openGaps,
} from './notebook'

test('normalizeUrl strips hash, trailing slash, and tracking params', () => {
  expect(normalizeUrl('https://Example.com/a/?utm_source=x&b=2#frag')).toBe('https://example.com/a/?b=2'.replace(/\/$/, ''))
  expect(normalizeUrl('https://example.com/a/')).toBe('https://example.com/a')
  expect(normalizeUrl('not a url')).toBe('not a url')
})

test('djb2 is stable and differs for different input', () => {
  expect(djb2('abc')).toBe(djb2('abc'))
  expect(djb2('abc')).not.toBe(djb2('abd'))
})

test('credibilityHint recognizes trust tiers', () => {
  expect(credibilityHint('https://nih.gov/x')).toBe('official')
  expect(credibilityHint('https://mit.edu/x')).toBe('academic')
  expect(credibilityHint('https://en.wikipedia.org/wiki/X')).toBe('reference')
  expect(credibilityHint('https://reddit.com/r/x')).toBe('user-generated')
  expect(credibilityHint('https://randomblog.io')).toBeUndefined()
})

test('addSource dedupes by normalized URL and assigns 1-based citation numbers', () => {
  const nb = createNotebook()
  const a = nb.addSource({ url: 'https://a.com/p', title: 'A' })
  const b = nb.addSource({ url: 'https://b.com/p', title: 'B' })
  // Same page via a tracking param + hash → same source, no new number.
  const aAgain = nb.addSource({ url: 'https://a.com/p?utm_source=z#top', title: 'A2' })
  expect(a.n).toBe(1)
  expect(b.n).toBe(2)
  expect(aAgain.n).toBe(1)
  expect(nb.get().sources).toHaveLength(2)
})

test('a real-tab render upgrades a prior headless fetch of the same URL', () => {
  const nb = createNotebook()
  nb.addSource({ url: 'https://a.com', fetchedVia: 'headless' })
  const upgraded = nb.addSource({ url: 'https://a.com', fetchedVia: 'tab' })
  expect(upgraded.fetchedVia).toBe('tab')
  expect(nb.get().sources).toHaveLength(1)
})

test('addFinding links to a source by URL and carries its citation number', () => {
  const nb = createNotebook()
  nb.addSource({ url: 'https://a.com', title: 'A' })
  const f = nb.addFinding({ claim: 'sky is blue', sourceUrl: 'https://a.com', quote: 'the sky is blue', confidence: 'high' })
  expect(f.sourceN).toBe(1)
  expect(f.confidence).toBe('high')
  const orphan = nb.addFinding({ claim: 'unknown' })
  expect(orphan.sourceN).toBeUndefined()
  expect(orphan.confidence).toBe('med')
})

test('addImage dedupes by URL and returns undefined on a repeat', () => {
  const nb = createNotebook()
  const first = nb.addImage({ url: 'https://a.com/i.png', caption: 'c', license: 'CC0' })
  const dup = nb.addImage({ url: 'https://a.com/i.png#x' })
  expect(first).toBeDefined()
  expect(dup).toBeUndefined()
  expect(nb.get().images).toHaveLength(1)
})

test('setCoverage drives isFullyCovered and openGaps', () => {
  const nb = createNotebook()
  nb.setPlan({ subQuestions: ['q1', 'q2'], outline: ['intro'] })
  expect(isFullyCovered(nb.get())).toBe(false)
  expect(openGaps(nb.get())).toEqual(['q1', 'q2'])
  nb.setCoverage('q1', { supported: true })
  nb.setCoverage('q2', { supported: false, gap: 'no data' })
  expect(openGaps(nb.get())).toEqual(['q2'])
  nb.setCoverage('q2', { supported: true })
  expect(isFullyCovered(nb.get())).toBe(true)
})

test('onChange fires on every mutation', () => {
  let n = 0
  const nb = createNotebook(emptyNotebook(), () => n++)
  nb.setPlan({ subQuestions: ['q'], outline: [] })
  nb.addSource({ url: 'https://a.com' })
  nb.addFinding({ claim: 'x' })
  nb.setCoverage('q', { supported: true })
  expect(n).toBe(4)
})

test('summarizeNotebook renders plan, coverage, findings, and numbered sources', () => {
  const nb = createNotebook()
  nb.setPlan({ subQuestions: ['What is X?'], outline: ['Background', 'Detail'] })
  nb.addSource({ url: 'https://a.com', title: 'Source A' })
  nb.addFinding({ claim: 'X is a thing', sourceUrl: 'https://a.com', confidence: 'high' })
  nb.setCoverage('What is X?', { supported: true })
  const s = summarizeNotebook(nb.get())
  expect(s).toContain('What is X? — supported')
  expect(s).toContain('OUTLINE: Background · Detail')
  expect(s).toContain('X is a thing [1]')
  expect(s).toContain('[1] Source A — https://a.com')
})
