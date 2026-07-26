import { describe, expect, it } from 'vitest'
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import variant from '@jitl/quickjs-wasmfile-release-sync'
import { runJs } from './engine'

const modPromise = newQuickJSWASMModuleFromVariant(variant)
const LIMITS = { timeoutMs: 2000, memoryBytes: 64 * 1024 * 1024 }

describe('runJs', () => {
  it('returns the completion value as JSON', async () => {
    const out = await runJs(await modPromise, '1 + 2', LIMITS)
    expect(out.ok).toBe(true)
    expect(out.value).toBe('3')
  })

  it('captures console output in order', async () => {
    const out = await runJs(await modPromise, 'console.log("a", 1); console.warn({b: 2}); "done"', LIMITS)
    expect(out.logs).toEqual(['a 1', '{"b":2}'])
    expect(out.value).toBe('"done"')
  })

  it('reports thrown errors with name and message', async () => {
    const out = await runJs(await modPromise, 'throw new RangeError("nope")', LIMITS)
    expect(out.ok).toBe(false)
    expect(out.error).toContain('RangeError')
    expect(out.error).toContain('nope')
  })

  it('interrupts an infinite loop at the deadline', async () => {
    const out = await runJs(await modPromise, 'while (true) {}', { ...LIMITS, timeoutMs: 100 })
    expect(out.ok).toBe(false)
    expect(out.timedOut).toBe(true)
  })

  it('enforces the memory cap', async () => {
    const out = await runJs(
      await modPromise,
      'const a = []; while (true) a.push(new Array(65536).fill(0))',
      { timeoutMs: 5000, memoryBytes: 8 * 1024 * 1024 },
    )
    expect(out.ok).toBe(false)
    expect(out.timedOut).toBe(false)
  })

  it('settles resolved promise chains', async () => {
    const out = await runJs(await modPromise, 'Promise.resolve(20).then((n) => n * 2)', LIMITS)
    expect(out.ok).toBe(true)
    expect(out.value).toBe('40')
  })

  it('fails a promise that can never settle (no timers exist)', async () => {
    const out = await runJs(await modPromise, 'new Promise(() => {})', LIMITS)
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/pending/i)
  })

  it('stringifies unserializable completion values', async () => {
    const out = await runJs(await modPromise, 'const a = {}; a.self = a; a', LIMITS)
    expect(out.ok).toBe(true)
    expect(typeof out.value).toBe('string')
  })
})
