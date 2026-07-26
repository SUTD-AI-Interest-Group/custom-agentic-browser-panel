# Sandboxed Code Execution + Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sealed-sandbox QuickJS execution host with a gated `RunCode` agent tool (stage 1) and self-contained HTML artifacts with `CreateArtifact`/`UpdateArtifact` tools and an in-chat preview card (stage 2).

**Architecture:** Untrusted AI-written code runs only inside a new manifest-sandboxed page `sandbox-exec.html` (opaque origin, `connect-src 'none'` via meta CSP, no `chrome.*`). The side panel fetches the QuickJS `.wasm` bytes itself and transfers them in by postMessage; the sandbox instantiates under its own `unsafe-eval` CSP. Artifacts persist in a new `lychee-artifacts` IndexedDB store (id-only tool results) and render by mounting the same sandbox page in render mode.

**Tech Stack:** quickjs-emscripten-core + @jitl/quickjs-wasmfile-release-sync, Vite 6 (second IIFE build config for the sandbox runtime), zod, vitest, existing Lychee patterns (`requestApproval`, `mcpArtifacts.ts`, `McpAppCard`).

**Reference spec:** `docs/superpowers/specs/2026-07-27-sandboxed-code-execution-design.md`

## Global Constraints

- Code style: no semicolons, single quotes, 2-space indent, `interface` for shapes, `/** ... */` on exports (per CLAUDE.md).
- Every agent tool gates on `requestApproval` before doing work; denial returns the module's `DENIED` constant (`src/tools/tools.ts:59`).
- Tool return values land in model history: never put large payloads there — ids only (budgets below).
- Everything ships in the extension package; no CDN fetches at runtime.
- The sandbox page never fetches assets itself (opaque origin): the panel transfers bytes/text in.
- Verify with `npm run typecheck` (NEVER `npx tsc` — decoy package risk), `npm test`, `npm run build`.
- Commit after each task, on this worktree branch (`worktree-sandboxed-exec`).

---

### Task 1: Execution engine (pure QuickJS wrapper) + dependencies

**Files:**
- Modify: `package.json` (two new deps)
- Create: `src/exec/engine.ts`
- Test: `src/exec/engine.test.ts`

**Interfaces:**
- Produces: `interface RunLimits { timeoutMs: number; memoryBytes: number; maxStackBytes?: number }`; `interface RunOutcome { ok: boolean; value?: string; logs: string[]; error?: string; timedOut: boolean; durationMs: number }`; `runJs(mod: QuickJSWASMModule, code: string, limits: RunLimits, now?: () => number): Promise<RunOutcome>`. Tasks 2, 3, 5 consume these.

- [ ] **Step 1: Install deps**

Run: `npm install quickjs-emscripten-core @jitl/quickjs-wasmfile-release-sync`
Expected: both appear in `package.json` dependencies; install succeeds through the symlinked node_modules.

- [ ] **Step 2: Write the failing tests**

`src/exec/engine.test.ts`:

```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/exec/engine.test.ts`
Expected: FAIL — cannot resolve `./engine`.

- [ ] **Step 4: Implement `src/exec/engine.ts`**

```ts
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
    if (state.type === 'fulfilled' && !state.notAPromise) {
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/exec/engine.test.ts`
Expected: PASS (8 tests). If `getPromiseState`'s shape differs in the installed version (check `node_modules/quickjs-emscripten-core/dist/index.d.ts` for `JSPromiseState`), adapt the fulfilled/notAPromise branch to the actual union — the tests define the required behavior.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck && git add package.json package-lock.json src/exec/ && git commit -m "feat(exec): QuickJS engine with memory/timeout limits"`

---

### Task 2: Message protocol + budgets (pure)

**Files:**
- Create: `src/exec/protocol.ts`
- Test: `src/exec/protocol.test.ts`

**Interfaces:**
- Consumes: `RunOutcome` from `./engine`.
- Produces (Tasks 3, 4, 5, 7, 8 consume): message interfaces `ExecInitMsg {type:'exec:init', requestId, wasm: ArrayBuffer}`, `ExecRunMsg {type:'exec:run', requestId, code, timeoutMs, memoryBytes}`, `ExecRenderMsg {type:'exec:render', requestId, html}`, union `ExecHostMsg`; `ExecReadyMsg {type:'exec:ready'}`, `ExecDoneMsg {type:'exec:done', requestId, ok, error?, outcome?: RunOutcome}`, union `ExecSandboxMsg`; guards `isExecHostMsg(d: unknown): d is ExecHostMsg`, `isExecSandboxMsg(d: unknown): d is ExecSandboxMsg`; budgets `LOGS_MAX = 40`, `LOG_LINE_MAX = 400`, `VALUE_MAX = 8000`, `RUN_TIMEOUT_MS = 5000`, `RUN_MEMORY_BYTES = 64 * 1024 * 1024`; `budgetOutcome(o: RunOutcome): { outcome: RunOutcome; valueOverflow: string | null }` (truncates logs/value with `… [truncated]` markers, returns the full value when it overflowed so the tool can spill it); `escapeHtml(s: string): string`.

- [ ] **Step 1: Write the failing tests** — cover: each guard accepts its own messages and rejects `null`/`{}`/wrong-type payloads; `budgetOutcome` passes a small outcome through untouched (`valueOverflow: null`), truncates `logs` to `LOGS_MAX` entries and each line to `LOG_LINE_MAX` with a final `… [+N more lines]` marker, truncates `value` beyond `VALUE_MAX` with `… [truncated]` and returns the original in `valueOverflow`; `escapeHtml('<a b="c">&')` → `&lt;a b=&quot;c&quot;&gt;&amp;`.
- [ ] **Step 2: Run to verify FAIL** — `npx vitest run src/exec/protocol.test.ts`.
- [ ] **Step 3: Implement** — plain interfaces + guards checking `typeof`/field presence (mirror the defensive style of `src/mcp/appBridge.ts`); budget/escape helpers are ~30 lines of pure string logic, no imports beyond `type { RunOutcome }`.
- [ ] **Step 4: Run to verify PASS.**
- [ ] **Step 5: Commit** — `git add src/exec/protocol.* && git commit -m "feat(exec): sandbox message protocol and output budgets"`

---

### Task 3: Sandbox page, runtime bundle, second Vite build, manifest

**Files:**
- Create: `public/sandbox-exec.html`, `src/exec/runtime.ts`, `vite.sandbox.config.ts`
- Modify: `public/manifest.json` (sandbox.pages), `package.json` (scripts)

**Interfaces:**
- Consumes: `runJs` (Task 1), protocol types/guards (Task 2).
- Produces: `dist/sandbox-exec.html` + `dist/sandbox-exec.js`; the page answers `exec:init`/`exec:run`/`exec:render` with `exec:done` and announces itself with `exec:ready`. Tasks 4 and 8 consume this contract.

- [ ] **Step 1: `public/sandbox-exec.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <!--
      The sealed code-execution sandbox. Manifest-sandboxed like sandbox.html
      (unique origin, no chrome.*, CSP permits eval/wasm), but with a TIGHTER
      profile: the meta CSP below removes network access entirely, so an
      interpreter escape lands in a page that can reach nothing. It never
      fetches its own assets — the panel transfers wasm bytes in by
      postMessage (an opaque origin fails CORS against chrome-extension://).
      The script is a classic (non-module) script for the same CORS reason,
      built as an IIFE by vite.sandbox.config.ts, NOT the main build.
    -->
    <meta http-equiv="Content-Security-Policy" content="connect-src 'none'" />
    <style>
      html,
      body {
        margin: 0;
        padding: 0;
        height: 100%;
        overflow: hidden;
        background: transparent;
      }
      iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
      }
    </style>
  </head>
  <body>
    <script src="sandbox-exec.js"></script>
  </body>
</html>
```

- [ ] **Step 2: `src/exec/runtime.ts`**

```ts
// The sandbox-side entry, bundled as a classic IIFE into dist/sandbox-exec.js
// (see vite.sandbox.config.ts). Runs inside sandbox-exec.html: no chrome.*,
// no network (connect-src 'none'), parent-postMessage only. Two duties:
// execute code (exec:init + exec:run, via the engine) and preview artifact
// HTML (exec:render, in a nested scripts-only srcdoc iframe — never
// allow-same-origin). All policy (approval, budgets) lives in the panel.

import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core'
import type { QuickJSWASMModule } from 'quickjs-emscripten-core'
import baseVariant from '@jitl/quickjs-wasmfile-release-sync'
import { runJs } from './engine'
import { isExecHostMsg, type ExecHostMsg, type ExecSandboxMsg } from './protocol'

let modPromise: Promise<QuickJSWASMModule> | null = null
let appFrame: HTMLIFrameElement | null = null

function post(msg: ExecSandboxMsg) {
  window.parent.postMessage(msg, '*')
}

window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return
  const msg = e.data
  if (!isExecHostMsg(msg)) return
  void handle(msg)
})

async function handle(msg: ExecHostMsg) {
  if (msg.type === 'exec:init') {
    try {
      modPromise = newQuickJSWASMModuleFromVariant(
        newVariant(baseVariant, { wasmBinary: msg.wasm }),
      )
      await modPromise
      post({ type: 'exec:done', requestId: msg.requestId, ok: true })
    } catch (err) {
      modPromise = null
      post({ type: 'exec:done', requestId: msg.requestId, ok: false, error: String(err) })
    }
    return
  }
  if (msg.type === 'exec:run') {
    if (!modPromise) {
      post({ type: 'exec:done', requestId: msg.requestId, ok: false, error: 'engine not initialized' })
      return
    }
    try {
      const mod = await modPromise
      const outcome = await runJs(mod, msg.code, {
        timeoutMs: msg.timeoutMs,
        memoryBytes: msg.memoryBytes,
      })
      post({ type: 'exec:done', requestId: msg.requestId, ok: true, outcome })
    } catch (err) {
      post({ type: 'exec:done', requestId: msg.requestId, ok: false, error: String(err) })
    }
    return
  }
  if (msg.type === 'exec:render') {
    if (appFrame) appFrame.remove()
    appFrame = document.createElement('iframe')
    appFrame.setAttribute('sandbox', 'allow-scripts allow-forms')
    appFrame.srcdoc = msg.html
    document.body.appendChild(appFrame)
    post({ type: 'exec:done', requestId: msg.requestId, ok: true })
  }
}

post({ type: 'exec:ready' })
```

- [ ] **Step 3: `vite.sandbox.config.ts`**

```ts
import { defineConfig } from 'vite'

// Second build: the sandbox runtime as a self-contained CLASSIC script.
// sandbox-exec.html has an opaque origin, so a module script would fail its
// CORS check — the runtime must be an IIFE. Runs after the main build
// (emptyOutDir: false) and emits exactly dist/sandbox-exec.js.
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/exec/runtime.ts',
      formats: ['iife'],
      name: 'LycheeExec',
      fileName: () => 'sandbox-exec.js',
    },
  },
})
```

- [ ] **Step 4: Wire manifest + scripts**

`public/manifest.json`: `"sandbox": { "pages": ["sandbox.html", "sandbox-exec.html"] }`.
`package.json` scripts:

```json
"dev": "vite build --watch --mode development",
"dev:sandbox": "vite build --watch --mode development -c vite.sandbox.config.ts",
"build": "tsc --noEmit && vite build && vite build -c vite.sandbox.config.ts",
"build:sandbox": "vite build -c vite.sandbox.config.ts",
```

- [ ] **Step 5: Verify the build**

Run: `npm run build && ls dist/sandbox-exec.js dist/sandbox-exec.html && head -c 200 dist/sandbox-exec.js`
Expected: both files exist; the JS starts with an IIFE (`var LycheeExec=...` or `(function(...)`), NOT `import`. If Rollup pulls Node-only variant code, set `resolve: { conditions: ['browser'] }` in the sandbox config.

- [ ] **Step 6: Commit** — `git add public/sandbox-exec.html public/manifest.json src/exec/runtime.ts vite.sandbox.config.ts package.json && git commit -m "feat(exec): sealed sandbox page + runtime IIFE build"`

---

### Task 4: Panel-side host (`ExecHost`)

**Files:**
- Create: `src/exec/host.ts`

**Interfaces:**
- Consumes: protocol messages/guards (Task 2), `RunOutcome` (Task 1), the page contract (Task 3).
- Produces (Task 5 consumes): `getExecHost(): ExecHost` with `run(code: string, limits: { timeoutMs: number; memoryBytes: number }): Promise<RunOutcome>` (rejects on sandbox death/round-trip timeout).

- [ ] **Step 1: Implement `src/exec/host.ts`**

```ts
// The panel-resident manager for the sealed execution sandbox — the McpManager
// analog. Owns one hidden sandbox-exec.html iframe: created lazily on first
// run, initialized once by fetching the bundled QuickJS wasm (the PANEL is
// same-origin; the sandbox is not, so bytes go in by postMessage transfer),
// and torn down + recreated if a round-trip wedges. Panel context only.

import wasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url'
import type { RunOutcome } from './engine'
import { isExecSandboxMsg, type ExecHostMsg } from './protocol'

const READY_TIMEOUT_MS = 10_000
const INIT_TIMEOUT_MS = 30_000
const RUN_GRACE_MS = 2_000

interface Pending {
  resolve: (msg: { ok: boolean; error?: string; outcome?: RunOutcome }) => void
  reject: (err: Error) => void
  timer: number
}

class ExecHost {
  private frame: HTMLIFrameElement | null = null
  private ready: Promise<void> | null = null
  private pending = new Map<string, Pending>()
  private onReady: (() => void) | null = null

  private listener = (e: MessageEvent) => {
    if (!this.frame || e.source !== this.frame.contentWindow) return
    const msg = e.data
    if (!isExecSandboxMsg(msg)) return
    if (msg.type === 'exec:ready') {
      this.onReady?.()
      this.onReady = null
      return
    }
    const p = this.pending.get(msg.requestId)
    if (!p) return
    this.pending.delete(msg.requestId)
    clearTimeout(p.timer)
    p.resolve(msg)
  }

  /** Run one script; rejects if the sandbox is dead or the round-trip wedges. */
  async run(code: string, limits: { timeoutMs: number; memoryBytes: number }): Promise<RunOutcome> {
    await this.ensure()
    const reply = await this.roundTrip(
      {
        type: 'exec:run',
        requestId: crypto.randomUUID(),
        code,
        timeoutMs: limits.timeoutMs,
        memoryBytes: limits.memoryBytes,
      },
      // The engine interrupts itself at timeoutMs; the grace covers messaging.
      limits.timeoutMs + RUN_GRACE_MS,
    )
    if (!reply.ok || !reply.outcome) throw new Error(reply.error ?? 'sandbox failed')
    return reply.outcome
  }

  private ensure(): Promise<void> {
    if (!this.ready) this.ready = this.boot()
    return this.ready
  }

  private async boot(): Promise<void> {
    try {
      const frame = document.createElement('iframe')
      frame.style.display = 'none'
      frame.src = chrome.runtime.getURL('sandbox-exec.html')
      window.addEventListener('message', this.listener)
      const readyGate = new Promise<void>((resolve, reject) => {
        const t = window.setTimeout(() => reject(new Error('sandbox never became ready')), READY_TIMEOUT_MS)
        this.onReady = () => {
          clearTimeout(t)
          resolve()
        }
      })
      document.body.appendChild(frame)
      this.frame = frame
      await readyGate
      const wasm = await fetch(wasmUrl).then((r) => r.arrayBuffer())
      const reply = await this.roundTrip(
        { type: 'exec:init', requestId: crypto.randomUUID(), wasm },
        INIT_TIMEOUT_MS,
        [wasm],
      )
      if (!reply.ok) throw new Error(reply.error ?? 'engine failed to initialize')
    } catch (err) {
      this.destroy()
      throw err
    }
  }

  private roundTrip(
    msg: ExecHostMsg,
    timeoutMs: number,
    transfer?: Transferable[],
  ): Promise<{ ok: boolean; error?: string; outcome?: RunOutcome }> {
    return new Promise((resolve, reject) => {
      const win = this.frame?.contentWindow
      if (!win) return reject(new Error('sandbox is not running'))
      const timer = window.setTimeout(() => {
        this.pending.delete(msg.requestId)
        // A wedged sandbox stays wedged — rebuild it for the next caller.
        this.destroy()
        reject(new Error('the sandbox stopped responding and was reset'))
      }, timeoutMs)
      this.pending.set(msg.requestId, { resolve, reject, timer })
      win.postMessage(msg, '*', transfer)
    })
  }

  private destroy() {
    window.removeEventListener('message', this.listener)
    this.frame?.remove()
    this.frame = null
    this.ready = null
    this.onReady = null
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('sandbox torn down'))
    }
    this.pending.clear()
  }
}

let host: ExecHost | null = null

/** The panel's execution-sandbox singleton (lazy; safe to import anywhere). */
export function getExecHost(): ExecHost {
  if (!host) host = new ExecHost()
  return host
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. If the `?url` import errors, add `src/vite-env.d.ts` containing `/// <reference types="vite/client" />` and include it (mirrors how `src/platform/pdf.ts:17` imports the pdf.js worker URL — that pattern already typechecks today). If the package's `/wasm` subpath export has a different name, check `node_modules/@jitl/quickjs-wasmfile-release-sync/package.json` `exports` and use the actual subpath.

- [ ] **Step 3: Commit** — `git add src/exec/host.ts && git commit -m "feat(exec): panel-side sandbox host with crash recovery"`

---

### Task 5: The `RunCode` tool

**Files:**
- Modify: `src/tools/tools.ts` (new imports + one new entry in the object `createAgentTools` returns — place it after the `GetElementScreenshot` entry, which ends near line 445)

**Interfaces:**
- Consumes: `getExecHost` (Task 4), `budgetOutcome`, `RUN_TIMEOUT_MS`, `RUN_MEMORY_BYTES` (Task 2), existing `requestApproval`/`DENIED`/`tool`/`z`.
- Produces: tool result shape `{ok: boolean, value?: string, logs?: string[], error?: string, durationMs: number}` or `DENIED` or `{error: string}`. (Task 7 extends this with value spillover.)

- [ ] **Step 1: Add imports** to `src/tools/tools.ts`:

```ts
import { getExecHost } from '../exec/host'
import { budgetOutcome, RUN_MEMORY_BYTES, RUN_TIMEOUT_MS } from '../exec/protocol'
```

- [ ] **Step 2: Add the tool entry** (inside the returned object literal):

```ts
RunCode: tool({
  description:
    'Execute JavaScript in a sealed sandbox and get its console output and completion value back. Use it when running code beats reasoning: calculations, data transforms, parsing, checking an algorithm. Pure computation only — no DOM, no network, no timers, no page or extension access; promise chains settle but nothing can wait on time. The value of the last expression is the result. Asks the user for permission first.',
  inputSchema: z.object({
    code: z.string().describe('The JavaScript to run. The last expression\'s value is returned.'),
    reason: z.string().describe('Short reason shown to the user, e.g. "To compute the amortization table"'),
  }),
  execute: async ({ code, reason }) => {
    const preview = code.length > 400 ? `${code.slice(0, 400)}…` : code
    const approved = await requestApproval({
      toolName: 'RunCode',
      summary: `Run JavaScript in the sandbox:\n${preview}`,
      reason,
    })
    if (!approved) return DENIED
    try {
      const raw = await getExecHost().run(code, { timeoutMs: RUN_TIMEOUT_MS, memoryBytes: RUN_MEMORY_BYTES })
      const { outcome } = budgetOutcome(raw)
      if (!outcome.ok) {
        return {
          ok: false,
          error: outcome.timedOut
            ? `Timed out after ${RUN_TIMEOUT_MS}ms. Break the work into smaller steps.`
            : outcome.error,
          logs: outcome.logs,
          durationMs: outcome.durationMs,
        }
      }
      return { ok: true, value: outcome.value, logs: outcome.logs, durationMs: outcome.durationMs }
    } catch (err) {
      return { error: `Sandbox failure: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}),
```

Before writing, read the surrounding entries to confirm the exact `requestApproval` argument fields in this file version and match them.

- [ ] **Step 3: Verify** — `npm run typecheck && npm test`
Expected: clean; `toolDiscovery`/agent tests still pass (the catalog derives from the ToolSet — no registration needed).

- [ ] **Step 4: Commit** — `git add src/tools/tools.ts && git commit -m "feat(tools): RunCode — gated sandboxed JavaScript execution"`

---

### Task 6: Artifacts store (`lychee-artifacts`)

**Files:**
- Create: `src/data/artifacts.ts`
- Test: `src/data/artifacts.test.ts` (pure prune planner only)
- Modify: `src/data/usage.ts` (StoreKey union), `src/data/storage.ts` (report/clear wiring), plus whatever `Record<StoreKey, …>` sites the compiler then flags (expect the Data tab in `src/ui/Settings.tsx` — add a display label there).

**Interfaces:**
- Consumes: `estimateBytes`, `StoreUsage` from `./usage`.
- Produces (Tasks 7, 8 consume): `interface CodeArtifact { id: string; title: string; html: string; revision: number; createdAt: number; updatedAt: number; conversationId: string; bytes: number }`; `saveArtifact(input: { title: string; html: string; conversationId: string }): Promise<CodeArtifact>`; `updateArtifactContent(id: string, patch: { html: string; title?: string }): Promise<CodeArtifact | null>`; `getArtifact(id: string): Promise<CodeArtifact | null>`; `deleteArtifactsForConversation(conversationId: string): Promise<void>`; `clearArtifacts(): Promise<void>`; `artifactsUsage(): Promise<StoreUsage>`; pure `planPrune(rows: Array<{ id: string; bytes: number; updatedAt: number }>, maxTotalBytes: number): string[]` (ids to evict, oldest-`updatedAt` first, until under the cap).

- [ ] **Step 1: Failing tests for `planPrune`** — under cap → `[]`; over cap → evicts oldest first, keeps newest; single over-cap row still evicted only if others exist? No: evict until `total <= max`, so one huge newest row alone is kept only if it fits — assert both directions.
- [ ] **Step 2: Verify FAIL**, then implement the module: copy `src/data/mcpArtifacts.ts`'s `openDb`/`requestOf` shape verbatim with `DB_NAME 'lychee-artifacts'`, `DB_VERSION 1`, `STORE 'artifacts'`, index `createdAt`; `MAX_TOTAL_BYTES = 20 * 1024 * 1024`; no age-based pruning (artifacts are the user's kept work, not transient media — a byte cap is protection enough; say so in a comment); after every save/update, load all rows and delete `planPrune(...)`'s ids best-effort.
- [ ] **Step 3: Wire accounting** — `usage.ts`: add `'artifacts'` to `StoreKey` (display order after `'mcp'`); `storage.ts`: import, add to `storageReport` `Promise.all`, add a `case 'artifacts': await clearArtifacts()` to the clear dispatch and `clearArtifacts()` to the erase-everything `Promise.all`. Run `npm run typecheck` and fix every `Record<StoreKey, …>` site it flags (expect a label/title map in the Settings Data tab — label it `Artifacts`).
- [ ] **Step 4: Verify** — `npm run typecheck && npm test` clean.
- [ ] **Step 5: Commit** — `git add src/data/ src/ui/ && git commit -m "feat(data): lychee-artifacts store with byte-cap pruning"`

---

### Task 7: `CreateArtifact` / `UpdateArtifact` tools + RunCode spillover

**Files:**
- Modify: `src/tools/tools.ts`

**Interfaces:**
- Consumes: store functions (Task 6), `escapeHtml`/`VALUE_MAX`/`budgetOutcome`'s `valueOverflow` (Task 2), `conversationId` (already a `createAgentTools` parameter).
- Produces: tool results `{artifactId, title, revision, note}` (create), `{artifactId, revision}` / `{error}` (update); RunCode gains `artifactId` in its result when the value overflowed.

- [ ] **Step 1: Add the two tools** (imports: `saveArtifact`, `updateArtifactContent` from `../data/artifacts`; `escapeHtml` from `../exec/protocol`):

```ts
CreateArtifact: tool({
  description:
    'Create a self-contained web artifact — one complete HTML document with inline CSS/JS — that the user can view and interact with as a card in the chat: a visualization, mini-app, formatted document, diagram, or game. It renders in a sealed sandbox with NO network (external scripts, CDNs and fonts will not load — inline everything), no storage, and no extension access. Returns an artifactId; revise the same artifact later with UpdateArtifact instead of creating a new one. Asks the user for permission first.',
  inputSchema: z.object({
    title: z.string().describe('Short human title shown on the card, e.g. "Loan repayment explorer"'),
    html: z.string().describe('The complete standalone HTML document (inline <style> and <script> only).'),
    reason: z.string().describe('Short reason shown to the user'),
  }),
  execute: async ({ title, html, reason }) => {
    const approved = await requestApproval({
      toolName: 'CreateArtifact',
      summary: `Create artifact "${title}" (${(html.length / 1024).toFixed(1)} KB of HTML)`,
      reason,
    })
    if (!approved) return DENIED
    const saved = await saveArtifact({ title, html, conversationId })
    return {
      artifactId: saved.id,
      title: saved.title,
      revision: saved.revision,
      note: 'The artifact is now rendered for the user. Use UpdateArtifact with this artifactId to revise it.',
    }
  },
}),

UpdateArtifact: tool({
  description:
    'Replace the HTML of an artifact you previously created with CreateArtifact, keeping its card and id. Send the COMPLETE new document, not a diff. Same sealed-sandbox rules: fully inline, no external URLs. Asks the user for permission first.',
  inputSchema: z.object({
    artifactId: z.string().describe('The artifactId returned by CreateArtifact.'),
    html: z.string().describe('The complete replacement HTML document.'),
    title: z.string().optional().describe('New title, only if it should change.'),
    reason: z.string().describe('Short reason shown to the user'),
  }),
  execute: async ({ artifactId, html, title, reason }) => {
    const approved = await requestApproval({
      toolName: 'UpdateArtifact',
      summary: `Update artifact ${title ? `"${title}"` : artifactId} (${(html.length / 1024).toFixed(1)} KB of HTML)`,
      reason,
    })
    if (!approved) return DENIED
    const updated = await updateArtifactContent(artifactId, { html, title })
    if (!updated) return { error: `No artifact with id ${artifactId} — it may have been pruned. Use CreateArtifact.` }
    return { artifactId: updated.id, revision: updated.revision }
  },
}),
```

- [ ] **Step 2: RunCode spillover** — in `RunCode`'s success path, use `budgetOutcome`'s `valueOverflow`: when non-null, save `{ title: 'RunCode output', html: '<!doctype html><meta charset="utf-8"><body style="margin:12px;font:13px monospace;white-space:pre-wrap">' + escapeHtml(valueOverflow), conversationId }` and add `artifactId` + a note (`'Full output was too large for chat and is shown to the user as an artifact.'`) to the result alongside the truncated `value`.
- [ ] **Step 3: Verify** — `npm run typecheck && npm test`.
- [ ] **Step 4: Commit** — `git add src/tools/tools.ts && git commit -m "feat(tools): CreateArtifact/UpdateArtifact + RunCode output spillover"`

---

### Task 8: `ArtifactCard` + transcript wiring

**Files:**
- Create: `src/ui/ArtifactCard.tsx`
- Modify: `src/ui/Chat.tsx` (tool renderer, beside the `output?.app` branch at ~line 3442), `src/ui/styles.css`

**Interfaces:**
- Consumes: `getArtifact`/`CodeArtifact` (Task 6), the sandbox page render contract (Task 3).
- Produces: `<ArtifactCard artifactId={string} revision={number | undefined} />`.

- [ ] **Step 1: Implement `src/ui/ArtifactCard.tsx`**

```tsx
// An agent-created artifact in the transcript. The tool result carries only
// the artifactId (payloads never ride model history); the HTML is read from
// the lychee-artifacts store on mount and rendered by mounting the SEALED
// sandbox page (sandbox-exec.html) in render mode — same isolation as code
// execution: opaque origin, no network, scripts-only nested iframe.

import { useEffect, useRef, useState } from 'react'
import { getArtifact, type CodeArtifact } from '../data/artifacts'

const COLLAPSED_H = 360
const EXPANDED_H = 720

export function ArtifactCard({ artifactId, revision }: { artifactId: string; revision?: number }) {
  const [artifact, setArtifact] = useState<CodeArtifact | null>(null)
  const [missing, setMissing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [frameReady, setFrameReady] = useState(false)
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  useEffect(() => {
    let stale = false
    getArtifact(artifactId).then((a) => {
      if (stale) return
      if (a) setArtifact(a)
      else setMissing(true)
    })
    return () => {
      stale = true
    }
  }, [artifactId, revision])

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return
      if (e.data && e.data.type === 'exec:ready') setFrameReady(true)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  useEffect(() => {
    if (!frameReady || !artifact) return
    frameRef.current?.contentWindow?.postMessage(
      { type: 'exec:render', requestId: crypto.randomUUID(), html: artifact.html },
      '*',
    )
  }, [frameReady, artifact])

  const download = () => {
    if (!artifact) return
    const url = URL.createObjectURL(new Blob([artifact.html], { type: 'text/html' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${artifact.title.replace(/[^\w-]+/g, '-').toLowerCase() || 'artifact'}.html`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (missing) return <div className="artifact-card artifact-missing">Artifact no longer stored.</div>

  return (
    <div className="artifact-card">
      <div className="artifact-head">
        <span className="artifact-title">{artifact?.title ?? '…'}</span>
        {artifact && artifact.revision > 1 && <span className="artifact-rev">v{artifact.revision}</span>}
        <button className="btn ghost small" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
        <button className="btn ghost small" onClick={download} disabled={!artifact}>
          Download
        </button>
      </div>
      <iframe
        ref={frameRef}
        title={artifact?.title ?? 'Artifact'}
        src={chrome.runtime.getURL('sandbox-exec.html')}
        style={{ height: expanded ? EXPANDED_H : COLLAPSED_H }}
      />
    </div>
  )
}
```

- [ ] **Step 2: Wire the renderer** — in `src/ui/Chat.tsx`, import `ArtifactCard` and add beside the `output?.app` branch (~line 3442):

```tsx
{typeof output?.artifactId === 'string' && (
  <ArtifactCard
    artifactId={output.artifactId}
    revision={typeof output?.revision === 'number' ? output.revision : undefined}
  />
)}
```

(RunCode spillover results also carry `artifactId` and get the card for free — intended.)

- [ ] **Step 3: Delete cascade** — mirror the screenshots/mcp pattern: wherever `Chat.tsx`/the conversation list calls the per-conversation deletes (search `ForConversation` in `src/ui/`; if only `deleteConversation` is called today, add the artifact cascade beside it), call `deleteArtifactsForConversation(conversationId)`.
- [ ] **Step 4: Styles** — add to `src/ui/styles.css`, matching existing card look (borders/radius from `.shot-card` neighborhood): `.artifact-card` (border, radius, overflow hidden), `.artifact-head` (flex row, gap, padding, muted background), `.artifact-title` (flex 1, ellipsis), `.artifact-rev` (small muted badge), `.artifact-card iframe` (width 100%, border 0, background white — artifact HTML assumes a light default), `.artifact-missing` (muted italic padding).
- [ ] **Step 5: Verify** — `npm run typecheck && npm test && npm run build`.
- [ ] **Step 6: Commit** — `git add src/ui/ && git commit -m "feat(ui): ArtifactCard renders artifacts in the sealed sandbox"`

---

### Task 9: End-to-end verification

**Files:** none (verification only; fix-forward commits as needed)

- [ ] **Step 1:** `npm run typecheck && npm test && npm run build` — all clean.
- [ ] **Step 2:** Load/reload the unpacked extension from this worktree's `dist/` in `chrome://extensions`, open the side panel, and exercise:
  1. Ask the agent to compute something non-trivial (e.g. "run code to find the 1000th prime"). Expect: ToolSearch→GetTool→RunCode approval card showing the code → result in chat with logs/value.
  2. Deny once — expect the standard denied handling, no sandbox left broken (a follow-up run works).
  3. Ask for an infinite loop ("run `while(true){}`") — expect a timeout error message, panel stays responsive.
  4. Ask the agent to "create a small interactive artifact" — expect approval card → rendered card in chat → Expand/Download work → an UpdateArtifact revision re-renders.
  5. Settings → Data shows an Artifacts row; clearing it empties the store.
- [ ] **Step 3:** Note any deviations found and fix in-place with focused commits.
