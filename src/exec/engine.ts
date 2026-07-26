// The QuickJS execution engine: one fresh, disposable interpreter per run,
// with hard limits the host cannot get from a plain Worker — a memory cap, a
// stack cap, and an instruction-level interrupt for wall-clock timeouts.
//
// This module is deliberately isomorphic: the sandbox runtime (runtime.ts)
// drives it in the sandboxed page, and vitest drives it in Node against the
// same wasm. It never touches the DOM, Chrome, or the message protocol.

import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from 'quickjs-emscripten-core'

/** Hard limits for one run. */
export interface RunLimits {
  timeoutMs: number
  memoryBytes: number
  maxStackBytes?: number
}

/** The result of one run — plain JSON, safe to postMessage. */
export interface RunOutcome {
  ok: boolean
  /** JSON text of the completion value (or its String() form when not JSON-able). */
  value?: string
  logs: string[]
  error?: string
  timedOut: boolean
  durationMs: number
}

const MAX_LOG_LINES = 200

/**
 * Run one script in a throwaway QuickJS runtime. The value of the last
 * expression is the completion value; already-settleable promise chains are
 * drained, but the sandbox has no timers, so a still-pending promise is an
 * error rather than a hang.
 */
export async function runJs(
  mod: QuickJSWASMModule,
  code: string,
  limits: RunLimits,
  now: () => number = Date.now,
): Promise<RunOutcome> {
  const started = now()
  const logs: string[] = []
  const runtime = mod.newRuntime()
  let timedOut = false
  const deadline = started + limits.timeoutMs
  runtime.setMemoryLimit(limits.memoryBytes)
  runtime.setMaxStackSize(limits.maxStackBytes ?? 1024 * 1024)
  runtime.setInterruptHandler(() => {
    if (now() > deadline) {
      timedOut = true
      return true
    }
    return false
  })
  const context = runtime.newContext()
  const done = (partial: Omit<RunOutcome, 'logs' | 'timedOut' | 'durationMs'>): RunOutcome => ({
    ...partial,
    logs,
    timedOut,
    durationMs: now() - started,
  })
  try {
    installConsole(context, logs)
    const result = context.evalCode(code)
    if (result.error) {
      const message = errorText(context, result.error)
      result.error.dispose()
      return done({ ok: false, error: message })
    }
    let handle = result.value
    // Drain microtasks so promise chains settle. Interrupts still apply here.
    runtime.executePendingJobs()
    const state = context.getPromiseState(handle)
    if (state.type === 'pending') {
      handle.dispose()
      return done({
        ok: false,
        error:
          'The result is a Promise that is still pending. The sandbox has no timers or I/O, so only synchronous work and already-resolvable promise chains can finish.',
      })
    }
    if (state.type === 'rejected') {
      const message = errorText(context, state.error)
      state.error.dispose()
      handle.dispose()
      return done({ ok: false, error: message })
    }
    if (!state.notAPromise) {
      handle.dispose()
      handle = state.value
    }
    const value = serialize(context, handle)
    handle.dispose()
    return done({ ok: true, value })
  } finally {
    context.dispose()
    runtime.dispose()
  }
}

/** console.{log,info,warn,error,debug} → captured lines (objects as JSON). */
function installConsole(context: QuickJSContext, logs: string[]) {
  const consoleObj = context.newObject()
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const fn = context.newFunction(level, (...args) => {
      if (logs.length >= MAX_LOG_LINES) return
      logs.push(args.map((h) => argText(context, h)).join(' '))
    })
    context.setProp(consoleObj, level, fn)
    fn.dispose()
  }
  context.setProp(context.global, 'console', consoleObj)
  consoleObj.dispose()
}

/** One console argument as text. Argument handles are borrowed — never disposed here. */
function argText(context: QuickJSContext, handle: QuickJSHandle): string {
  try {
    const v = context.dump(handle)
    if (typeof v === 'string') return v
    const json = JSON.stringify(v)
    return json === undefined ? String(v) : json
  } catch {
    return '[unserializable]'
  }
}

/** A thrown/rejected value as "Name: message" (or its dump for non-Errors). */
function errorText(context: QuickJSContext, handle: QuickJSHandle): string {
  try {
    const e = context.dump(handle)
    if (e && typeof e === 'object' && 'message' in e) {
      const name = 'name' in e && typeof e.name === 'string' ? e.name : 'Error'
      return `${name}: ${String((e as { message: unknown }).message)}`
    }
    return String(JSON.stringify(e) ?? e)
  } catch {
    return 'Error: [unserializable thrown value]'
  }
}

/**
 * Completion value → JSON text, serialized INSIDE the vm so cycles and exotic
 * values degrade to String(v) instead of throwing across the boundary.
 */
function serialize(context: QuickJSContext, handle: QuickJSHandle): string {
  const fnResult = context.evalCode(
    `(v) => { if (v === undefined) return 'undefined'; try { const s = JSON.stringify(v); return s === undefined ? String(v) : s } catch { return String(v) } }`,
  )
  const fn = context.unwrapResult(fnResult)
  const call = context.callFunction(fn, context.undefined, handle)
  fn.dispose()
  if (call.error) {
    const message = errorText(context, call.error)
    call.error.dispose()
    return message
  }
  const text = context.getString(call.value)
  call.value.dispose()
  return text
}
