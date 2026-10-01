import { afterEach, describe, expect, it, vi } from 'vitest'

// import.meta.env.VITE_SYSTEM1_PIN (honoured only when MODE is system1-eval)
// drives WEIGHTS_PIN at module-load time, so each case stubs them, resets the
// module cache, and re-imports fresh.
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('WEIGHTS_PIN', () => {
  it('is the committed published pin when no override is set — a commit sha and a manifest hash, never a branch', async () => {
    vi.resetModules()
    const { WEIGHTS_PIN } = await import('./weightsManifest')
    expect(WEIGHTS_PIN).toEqual({ repo: 'ks-ang/von-browser-act', revision: '6f1783b63a4ec4049206496998bfc2f88a5a062a', manifestSha256: '7d5ff043d9674ce8cca4b8b96e507d09a324f381edacb51144e7374ccecefc1e' })
    expect(WEIGHTS_PIN.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(WEIGHTS_PIN.manifestSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('ignores VITE_SYSTEM1_PIN outside a system1-eval build', async () => {
    vi.stubEnv('MODE', 'production')
    vi.stubEnv('VITE_SYSTEM1_PIN', JSON.stringify({ repo: 'me/von', revision: 'abc123', manifestSha256: 'f'.repeat(64) }))
    vi.resetModules()
    const { WEIGHTS_PIN } = await import('./weightsManifest')
    expect(WEIGHTS_PIN).toEqual({ repo: 'ks-ang/von-browser-act', revision: '6f1783b63a4ec4049206496998bfc2f88a5a062a', manifestSha256: '7d5ff043d9674ce8cca4b8b96e507d09a324f381edacb51144e7374ccecefc1e' })
  })

  it('does not even parse a malformed override outside a system1-eval build', async () => {
    vi.stubEnv('MODE', 'development')
    vi.stubEnv('VITE_SYSTEM1_PIN', 'not json')
    vi.resetModules()
    const { WEIGHTS_PIN } = await import('./weightsManifest')
    expect(WEIGHTS_PIN.repo).toBe('ks-ang/von-browser-act')
  })

  it('honours a well-formed VITE_SYSTEM1_PIN override in a system1-eval build', async () => {
    vi.stubEnv('MODE', 'system1-eval')
    vi.stubEnv('VITE_SYSTEM1_PIN', JSON.stringify({ repo: 'me/von', revision: 'abc123', manifestSha256: 'f'.repeat(64) }))
    vi.resetModules()
    const { WEIGHTS_PIN } = await import('./weightsManifest')
    expect(WEIGHTS_PIN).toEqual({ repo: 'me/von', revision: 'abc123', manifestSha256: 'f'.repeat(64) })
  })

  it('throws at module load on invalid JSON', async () => {
    vi.stubEnv('MODE', 'system1-eval')
    vi.stubEnv('VITE_SYSTEM1_PIN', 'not json')
    vi.resetModules()
    await expect(import('./weightsManifest')).rejects.toThrow(/not valid JSON/)
  })

  it('throws at module load when a field is missing or empty', async () => {
    vi.stubEnv('MODE', 'system1-eval')
    vi.stubEnv('VITE_SYSTEM1_PIN', JSON.stringify({ repo: 'me/von', revision: '' }))
    vi.resetModules()
    await expect(import('./weightsManifest')).rejects.toThrow(/non-empty strings/)
  })
})
