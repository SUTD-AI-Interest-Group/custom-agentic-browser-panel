import { afterEach, describe, expect, it, vi } from 'vitest'

// import.meta.env.VITE_SYSTEM1_PIN drives WEIGHTS_PIN at module-load time, so
// each case stubs it, resets the module cache, and re-imports fresh.
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('WEIGHTS_PIN', () => {
  it('is the committed empty pin when no override is set', async () => {
    vi.resetModules()
    const { WEIGHTS_PIN } = await import('./weightsManifest')
    expect(WEIGHTS_PIN).toEqual({ repo: '', revision: '', manifestSha256: '' })
  })

  it('honours a well-formed VITE_SYSTEM1_PIN override', async () => {
    vi.stubEnv('VITE_SYSTEM1_PIN', JSON.stringify({ repo: 'me/von', revision: 'abc123', manifestSha256: 'f'.repeat(64) }))
    vi.resetModules()
    const { WEIGHTS_PIN } = await import('./weightsManifest')
    expect(WEIGHTS_PIN).toEqual({ repo: 'me/von', revision: 'abc123', manifestSha256: 'f'.repeat(64) })
  })

  it('throws at module load on invalid JSON', async () => {
    vi.stubEnv('VITE_SYSTEM1_PIN', 'not json')
    vi.resetModules()
    await expect(import('./weightsManifest')).rejects.toThrow(/not valid JSON/)
  })

  it('throws at module load when a field is missing or empty', async () => {
    vi.stubEnv('VITE_SYSTEM1_PIN', JSON.stringify({ repo: 'me/von', revision: '' }))
    vi.resetModules()
    await expect(import('./weightsManifest')).rejects.toThrow(/non-empty strings/)
  })
})
