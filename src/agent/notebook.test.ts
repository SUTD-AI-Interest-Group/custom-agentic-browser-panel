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
  expect(a!.n).toBe(1)
  expect(b!.n).toBe(2)
  expect(aAgain!.n).toBe(1)
  expect(nb.get().sources).toHaveLength(2)
})

test('a real-tab render upgrades a prior headless fetch of the same URL', () => {
  const nb = createNotebook()
  nb.addSource({ url: 'https://a.com', fetchedVia: 'headless' })
  const upgraded = nb.addSource({ url: 'https://a.com', fetchedVia: 'tab' })
  expect(upgraded!.fetchedVia).toBe('tab')
  expect(nb.get().sources).toHaveLength(1)
})

test('addFinding links to a source by URL and carries its citation number', () => {
  const nb = createNotebook()
  nb.addSource({ url: 'https://a.com', title: 'A' })
  const f = nb.addFinding({ claim: 'sky is blue', sourceUrl: 'https://a.com', quote: 'the sky is blue', confidence: 'high' })
  expect(f!.sourceN).toBe(1)
  expect(f!.confidence).toBe('high')
  const orphan = nb.addFinding({ claim: 'unknown' })
  expect(orphan!.sourceN).toBeUndefined()
  expect(orphan!.confidence).toBe('med')
})

test('addImage dedupes by URL and returns undefined on a repeat', () => {
  const nb = createNotebook()
  const first = nb.addImage({ url: 'https://a.com/i.png', caption: 'c', license: 'CC0' })
  const dup = nb.addImage({ url: 'https://a.com/i.png#x' })
  expect(first).toBeDefined()
  expect(dup).toBeUndefined()
  expect(nb.get().images).toHaveLength(1)
})

test('addImage refuses a URL that fails the safe-render check and records nothing', () => {
  const nb = createNotebook()
  // A SearchImages/HarvestImages result pointing at a cloud metadata endpoint —
  // harvested from attacker-influenced page content, never reviewed by a human
  // before the report would otherwise embed it as an auto-fetching <img src>.
  const blocked = nb.addImage({ url: 'http://169.254.169.254/latest/meta-data/', caption: 'x' })
  expect(blocked).toBeUndefined()
  expect(nb.get().images).toHaveLength(0)
})

test('addImage still records an ordinary public image URL', () => {
  const nb = createNotebook()
  const img = nb.addImage({ url: 'https://example.com/photo.jpg', caption: 'a photo', license: 'CC-BY' })
  expect(img).toBeDefined()
  expect(img?.url).toBe('https://example.com/photo.jpg')
  expect(nb.get().images).toHaveLength(1)
})

test('addImage rejecting an unsafe URL does not fire onChange (no state actually changed)', () => {
  let n = 0
  const nb = createNotebook(emptyNotebook(), () => n++)
  nb.addImage({ url: 'http://127.0.0.1/x.png' })
  expect(n).toBe(0)
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

test('summarizeNotebook caps SOURCES to the most recent maxSources and notes the rest', () => {
  const nb = createNotebook()
  for (let i = 1; i <= 5; i++) {
    nb.addSource({ url: `https://s${i}.com`, title: `Source ${i}` })
  }
  const s = summarizeNotebook(nb.get(), { maxSources: 2 })
  // Only the two most-recently-added sources are listed...
  expect(s).toContain('[4] Source 4 — https://s4.com')
  expect(s).toContain('[5] Source 5 — https://s5.com')
  expect(s).not.toContain('[1] Source 1 — https://s1.com')
  expect(s).not.toContain('[3] Source 3 — https://s3.com')
  // ...and the omitted count is called out.
  expect(s).toContain('…and 3 more sources')
})

// ---- Source scope: the write boundary IS the scope boundary ----------------
// Research may browse anywhere (isSafeResearchAction permits cross-origin
// navigation by design), but the report may only cite what the user pinned on
// the launch card. These pin that the notebook is where that is enforced, so it
// binds every writer — including the browse sub-agent, which knows nothing
// about scope.

test('an unscoped notebook records everything, exactly as before', () => {
  const nb = createNotebook()
  expect(nb.addSource({ url: 'https://anywhere.test/x' })).toBeTruthy()
  expect(nb.addFinding({ claim: 'c', sourceUrl: 'https://anywhere.test/x' })).toBeTruthy()
  expect(nb.get().sources).toHaveLength(1)
  expect(nb.get().findings).toHaveLength(1)
})

test('a scoped notebook refuses an out-of-scope source and admits subdomains', () => {
  const nb = createNotebook(undefined, undefined, ['aftershockpc.com'])
  expect(nb.addSource({ url: 'https://lenovo.com/pgx' })).toBeUndefined()
  expect(nb.addSource({ url: 'https://sg.aftershockpc.com/apex' })).toBeTruthy()
  expect(nb.get().sources).toHaveLength(1)
})

test('a scoped notebook refuses a finding cited to an out-of-scope host', () => {
  const nb = createNotebook(undefined, undefined, ['aftershockpc.com'])
  expect(nb.addFinding({ claim: 'the PGX has 128GB', sourceUrl: 'https://lenovo.com/pgx' })).toBeUndefined()
  expect(nb.get().findings).toHaveLength(0)
})

// The load-bearing case: addFinding must test sourceUrl DIRECTLY, not infer
// scope from whether the source resolved. Checking the lookup instead would
// demote an out-of-scope claim to an uncited one and record it anyway — which
// is precisely how an unrelated vendor's machine ended up in a real report.
test('an out-of-scope claim is refused outright, not demoted to uncited', () => {
  const nb = createNotebook(undefined, undefined, ['aftershockpc.com'])
  nb.addSource({ url: 'https://lenovo.com/pgx' }) // already refused
  const f = nb.addFinding({ claim: 'the PGX belongs in this comparison', sourceUrl: 'https://lenovo.com/pgx' })
  expect(f).toBeUndefined()
  expect(nb.get().findings).toHaveLength(0)
})

// An uncited finding has no host to misattribute to, and refusing it would
// silently drop the agent's own synthesis across the sources it DID read.
test('a scoped notebook still records an uncited finding', () => {
  const nb = createNotebook(undefined, undefined, ['aftershockpc.com'])
  expect(nb.addFinding({ claim: 'prices cluster in two tiers' })).toBeTruthy()
  expect(nb.get().findings).toHaveLength(1)
})

test('a scoped notebook refuses an image by its own url or by its source page', () => {
  const nb = createNotebook(undefined, undefined, ['aftershockpc.com'])
  // Out-of-scope image hosted off an in-scope page.
  expect(nb.addImage({ url: 'https://cdn.lenovo.com/a.png', sourceUrl: 'https://aftershockpc.com/x' })).toBeUndefined()
  // In-scope image laundered through an out-of-scope page.
  expect(nb.addImage({ url: 'https://aftershockpc.com/a.png', sourceUrl: 'https://lenovo.com/x' })).toBeUndefined()
  expect(nb.addImage({ url: 'https://aftershockpc.com/b.png', sourceUrl: 'https://aftershockpc.com/x' })).toBeTruthy()
  expect(nb.get().images).toHaveLength(1)
})
