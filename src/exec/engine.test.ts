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

  // Gap the audit flagged: only the resolved-chain and never-settles branches
  // of getPromiseState were covered; a rejected completion value was untested.
  it('reports a rejected promise as the completion error', async () => {
    const out = await runJs(await modPromise, 'Promise.reject(new Error("nope"))', LIMITS)
    expect(out.ok).toBe(false)
    expect(out.error).toContain('nope')
  })

  it('reports a syntax error cleanly instead of crashing or hanging', async () => {
    const out = await runJs(await modPromise, 'const a = ;', LIMITS)
    expect(out.ok).toBe(false)
    expect(out.error).toBeTruthy()
  })

  // Gap the audit flagged: nothing confirmed that a fresh runtime+context per
  // call (mod.newRuntime()/runtime.newContext() in runJs) actually isolates
  // state between separate runs sharing one wasm module — exactly the
  // "does state leak between executions" property this audit was asked about.
  it('does not leak state between separate runs sharing one module', async () => {
    const mod = await modPromise
    const first = await runJs(mod, 'globalThis.leaked = 42; leaked', LIMITS)
    expect(first.value).toBe('42')
    const second = await runJs(mod, 'typeof leaked', LIMITS)
    expect(second.value).toBe('"undefined"')
  })

  // F4 (d10): once MAX_LOG_LINES is hit, further console output was dropped
  // with no trace — the panel's later "+N more" note only counted its own
  // 40-line trim, silently understating true log volume for a script that
  // logged heavily (e.g. "+160 more" when 4,960 lines were actually lost).
  it('caps captured log lines and reports how many were dropped', async () => {
    const out = await runJs(await modPromise, 'for (let i = 0; i < 300; i++) console.log(i); "done"', LIMITS)
    expect(out.logs.length).toBe(200)
    expect(out.logsDropped).toBe(100)
  })

  it('does not report a drop count when nothing was dropped', async () => {
    const out = await runJs(await modPromise, 'console.log("only one"); "done"', LIMITS)
    expect(out.logsDropped).toBeFalsy()
  })

  // F5 (d10): a single huge console argument had no cap of its own short of
  // the whole VM's memory ceiling, so it could reach the postMessage
  // boundary (and the panel's structured-clone cost) essentially unbounded.
  it('caps a single very large console argument before it is captured', async () => {
    const out = await runJs(await modPromise, 'console.log("x".repeat(1_000_000)); "done"', LIMITS)
    expect(out.logs[0].length).toBeLessThan(10_000)
  })
})
