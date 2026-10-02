import { describe, it, expect, vi, afterEach } from 'vitest'
import { removeLegacySystem1, LEGACY_SYSTEM1_CACHE, LEGACY_SYSTEM1_STATE_KEY } from './legacyCleanup'

afterEach(() => vi.unstubAllGlobals())

describe('removeLegacySystem1', () => {
  it('deletes the old weights cache and the readiness flag', async () => {
    const del = vi.fn(async () => true)
    const remove = vi.fn(async () => {})
    vi.stubGlobal('caches', { delete: del })
    vi.stubGlobal('chrome', { storage: { local: { remove } } })
    await removeLegacySystem1()
    expect(del).toHaveBeenCalledWith(LEGACY_SYSTEM1_CACHE)
    expect(remove).toHaveBeenCalledWith(LEGACY_SYSTEM1_STATE_KEY)
  })

  it('still clears the flag when Cache Storage throws, and never rejects', async () => {
    const remove = vi.fn(async () => {})
    vi.stubGlobal('caches', { delete: vi.fn(async () => { throw new Error('no caches') }) })
    vi.stubGlobal('chrome', { storage: { local: { remove } } })
    await expect(removeLegacySystem1()).resolves.toBeUndefined()
    expect(remove).toHaveBeenCalled()
  })
})
