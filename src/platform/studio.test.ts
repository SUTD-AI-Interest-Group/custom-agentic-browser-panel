import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyBoost } from '../data/studio'
import { registerBoostScript } from './studio'
const api = {
  getScripts: vi.fn(),
  register: vi.fn(),
  update: vi.fn(),
  unregister: vi.fn(),
}
beforeEach(() => {
  vi.clearAllMocks()
  api.getScripts.mockResolvedValue([])
  vi.stubGlobal('chrome', { userScripts: api })
})
afterEach(() => vi.unstubAllGlobals())
it('registers code in an isolated world with an exact origin guard, including port', async () => {
  await registerBoostScript({
    ...emptyBoost('https://example.com:8443'),
    js: 'document.title = "Edited"',
  })
  const script = api.register.mock.calls[0][0][0]
  expect(script.matches).toEqual(['https://example.com/*'])
  expect(script.js[0].code).toContain(
    'location.origin === "https://example.com:8443"',
  )
  expect(script.world).toBe('USER_SCRIPT')
  expect(script.runAt).toBe('document_idle')
})
it('updates an existing script and removes it when disabled or cleared', async () => {
  const boost = {
    ...emptyBoost('https://example.com'),
    js: 'document.title = "Edited"',
  }
  api.getScripts.mockResolvedValue([{ id: 'existing' }])
  await registerBoostScript(boost)
  expect(api.update).toHaveBeenCalledOnce()
  expect(api.register).not.toHaveBeenCalled()
  await registerBoostScript({ ...boost, enabled: false })
  await registerBoostScript({ ...boost, js: '' })
  expect(api.unregister).toHaveBeenCalledTimes(2)
})
it('surfaces browser permission failures rather than reporting a save', async () => {
  api.getScripts.mockRejectedValue(new Error('not allowed'))
  await expect(
    registerBoostScript({ ...emptyBoost('https://example.com'), js: 'void 0' }),
  ).rejects.toThrow('Allow user scripts')
})

it('guards restored JavaScript against duplicate runs within a document', async () => {
  const { boostScriptCode } = await import('./studio')
  const { runInNewContext } = await import('node:vm')
  const boost = {
    ...emptyBoost('https://example.com'),
    js: 'globalThis.runs = (globalThis.runs || 0) + 1',
  }
  const documentWorld = { location: { origin: boost.origin }, runs: 0 }
  runInNewContext(boostScriptCode(boost), documentWorld)
  runInNewContext(boostScriptCode(boost), documentWorld)
  expect(documentWorld.runs).toBe(1)
  const otherOrigin = {
    location: { origin: 'https://example.com:8443' },
    runs: 0,
  }
  runInNewContext(boostScriptCode(boost), otherOrigin)
  expect(otherOrigin.runs).toBe(0)
  const reloadedWorld = { location: { origin: boost.origin }, runs: 0 }
  runInNewContext(boostScriptCode(boost), reloadedWorld)
  expect(reloadedWorld.runs).toBe(1)
})
