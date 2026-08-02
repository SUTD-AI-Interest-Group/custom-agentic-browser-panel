import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { _putShotForTests, _resetDbForTests, getShot, pruneShots, type StoredShot } from './screenshots'

// pruneShots' eviction math (F4) is exercised directly against the IndexedDB
// store rather than through saveShot(): saveShot's makeThumb() decodes the
// image via a real <canvas>, which jsdom has no native binding for (getContext
// always returns null here — see pdf.test.ts's header comment for the same
// constraint) — _putShotForTests bypasses that entirely and writes only what
// pruneShots actually reads.

function shot(overrides: Partial<StoredShot> & Pick<StoredShot, 'id' | 'bytes' | 'createdAt'>): StoredShot {
  return {
    dataUrl: 'data:image/png;base64,x',
    width: 100,
    height: 100,
    url: 'https://example.com',
    title: 'Example',
    label: 'the full page',
    conversationId: 'c1',
    ...overrides,
  }
}

beforeEach(async () => {
  await _resetDbForTests()
})

describe('pruneShots', () => {
  it('keeps the newest shot even when it alone exceeds MAX_TOTAL_BYTES', async () => {
    // MAX_TOTAL_BYTES is 50MB. A single capture over that cap must survive its
    // own very next prune — not vanish out from under the card the UI just
    // rendered for it as "saved" (F4).
    await _putShotForTests(shot({ id: 'huge', bytes: 60 * 1024 * 1024, createdAt: Date.now() }))
    const result = await pruneShots()
    expect(result.deleted).toBe(0)
    expect(await getShot('huge')).not.toBeNull()
  })

  it('still evicts an oversized OLDER shot once a newer one exists', async () => {
    // Both well within MAX_AGE_MS (30 days) — recency here differs only by
    // the byte-cap pass's oldest-first ordering, not by age eviction.
    await _putShotForTests(shot({ id: 'old-huge', bytes: 60 * 1024 * 1024, createdAt: Date.now() - 2_000 }))
    await _putShotForTests(shot({ id: 'new-small', bytes: 10, createdAt: Date.now() - 1_000 }))
    const result = await pruneShots()
    expect(result.deleted).toBe(1)
    expect(await getShot('old-huge')).toBeNull()
    expect(await getShot('new-small')).not.toBeNull()
  })

  it('evicts shots past MAX_AGE_MS regardless of size', async () => {
    const ancient = Date.now() - 31 * 24 * 60 * 60 * 1000 // 31 days old; cap is 30
    await _putShotForTests(shot({ id: 'ancient', bytes: 10, createdAt: ancient }))
    const result = await pruneShots()
    expect(result.deleted).toBe(1)
    expect(await getShot('ancient')).toBeNull()
  })
})
