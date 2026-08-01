// ExecHost regression tests for the per-call isolation fix: two RunCode calls
// in one model step is the AI SDK's default concurrent-tool-call behavior
// (see the audit's F1/F3), but the sandbox is a single JS realm servicing
// exec:run messages one at a time — pre-fix, each call's timeout clock ran
// from POST time rather than SERVICE time, so a call queued behind a slow one
// could time out from pure queuing delay and collaterally reject every other
// pending call via destroy(). These tests drive ExecHost against a fake
// iframe/contentWindow — no real QuickJS engine involved, only the host's own
// message-timing and teardown logic.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExecHost } from './host'
import type { RunOutcome } from './engine'
import type { ExecHostMsg } from './protocol'

function outcome(value: string): RunOutcome {
  return { ok: true, value, logs: [], timedOut: false, durationMs: 1 }
}

/**
 * A controllable stand-in for the sandbox iframe. document.createElement /
 * document.body.appendChild are patched so ExecHost's real DOM calls succeed
 * against a plain object instead of a real Node (jsdom's appendChild
 * WebIDL-checks its argument, so a fake element can't just be passed
 * through); contentWindow.postMessage records outgoing messages instead of
 * driving a real sandbox, and replies are delivered by dispatching a real
 * `message` event at `window` — ExecHost's own listener is a plain
 * `window.addEventListener('message', ...)` matched by `e.source`.
 */
function fakeSandbox() {
  const posted: ExecHostMsg[] = []
  const contentWindow = {
    postMessage: vi.fn((msg: ExecHostMsg) => {
      posted.push(msg)
    }),
  }
  const frame = {
    style: {} as Record<string, string>,
    src: '',
    remove: vi.fn(),
    contentWindow,
  }
  const realCreateElement = document.createElement.bind(document)
  const createElementSpy = vi
    .spyOn(document, 'createElement')
    .mockImplementation(((tag: string, opts?: ElementCreationOptions) => {
      if (tag === 'iframe') return frame as unknown as HTMLIFrameElement
      return realCreateElement(tag, opts)
    }) as typeof document.createElement)
  const appendChildSpy = vi
    .spyOn(document.body, 'appendChild')
    .mockImplementation(((node: Node) => node) as typeof document.body.appendChild)

  function ready() {
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'exec:ready' }, source: contentWindow as unknown as Window }),
    )
  }

  function reply(requestId: string, data: { ok: boolean; error?: string; outcome?: RunOutcome }) {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'exec:done', requestId, ...data },
        source: contentWindow as unknown as Window,
      }),
    )
  }

  function restore() {
    createElementSpy.mockRestore()
    appendChildSpy.mockRestore()
  }

  return { posted, contentWindow, frame, ready, reply, restore }
}

async function flushMicrotasks(times = 10) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** Last matching entry — a re-boot posts a second exec:init, so "first match" would grab the stale one. */
function findLast<T, S extends T>(arr: T[], pred: (t: T) => t is S): S | undefined
function findLast<T>(arr: T[], pred: (t: T) => boolean): T | undefined
function findLast<T>(arr: T[], pred: (t: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i]
  return undefined
}

type Sandbox = ReturnType<typeof fakeSandbox>

/** Services one boot handshake (ready + exec:init) so `run` calls can proceed — callable again after a re-boot. */
async function completeBoot(sandbox: Sandbox) {
  await flushMicrotasks()
  sandbox.ready()
  await flushMicrotasks()
  const initMsg = findLast(sandbox.posted, (m) => m.type === 'exec:init')
  if (!initMsg) throw new Error('exec:init was never posted — boot sequencing assumption is wrong')
  sandbox.reply(initMsg.requestId, { ok: true })
  await flushMicrotasks()
}

/** The most recently posted, still-unanswered exec:run message for `code`. */
function findRun(sandbox: Sandbox, code: string): Extract<ExecHostMsg, { type: 'exec:run' }> {
  const msg = findLast(sandbox.posted, (m): m is Extract<ExecHostMsg, { type: 'exec:run' }> => m.type === 'exec:run' && m.code === code)
  if (!msg) throw new Error(`exec:run for ${JSON.stringify(code)} was never posted`)
  return msg
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) }))
  vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://fake/${p}` } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ExecHost', () => {
  it('boots and completes a single run', async () => {
    const sandbox = fakeSandbox()
    try {
      const host = new ExecHost()
      const runPromise = host.run('1', { timeoutMs: 5000, memoryBytes: 1000 })
      await completeBoot(sandbox)
      const runMsg = findRun(sandbox, '1')
      sandbox.reply(runMsg.requestId, { ok: true, outcome: outcome('1') })
      const result = await runPromise
      expect(result.value).toBe('1')
    } finally {
      sandbox.restore()
    }
  })

  it('does not leak an unresolved call\'s promise into the next request (baseline sanity)', async () => {
    const sandbox = fakeSandbox()
    try {
      const host = new ExecHost()
      const first = host.run('a', { timeoutMs: 5000, memoryBytes: 1000 })
      await completeBoot(sandbox)
      const firstRun = findRun(sandbox, 'a')
      sandbox.reply(firstRun.requestId, { ok: true, outcome: outcome('a') })
      expect((await first).value).toBe('a')

  const second = host.run('b', { timeoutMs: 5000, memoryBytes: 1000 })
      await flushMicrotasks()
      const secondRun = findRun(sandbox, 'b')
      sandbox.reply(secondRun.requestId, { ok: true, outcome: outcome('b') })
      expect((await second).value).toBe('b')
    } finally {
      sandbox.restore()
    }
  })

  // F3 (d10): the AI SDK runs same-step tool calls concurrently (see F1), and
  // the sandbox is a single JS realm — evalCode is synchronous, so a second
  // exec:run cannot actually be serviced until the first's finishes. Pre-fix,
  // both calls' timeout clocks started at POST time regardless, so a call
  // that never got a fair shot at its own budget could still be timed out —
  // and worse, that timeout's destroy() force-rejected every other pending
  // call, not just the one that wedged.
  it('a call queued behind one that times out still gets its own full, fresh attempt', async () => {
    vi.useFakeTimers()
    const sandbox = fakeSandbox()
    try {
      const host = new ExecHost()
      const slow = host.run('slow', { timeoutMs: 100, memoryBytes: 1000 })
      // 'slow' is expected to reject once its timeout fires below — attach a
      // handler right away so vi.advanceTimersByTimeAsync settling it doesn't
      // trip Node's unhandled-rejection warning in the gap before the
      // `expect(...).rejects` assertion itself attaches one.
      slow.catch(() => {})
      await completeBoot(sandbox)

      // Queued immediately behind it, before 'slow' ever replies — exactly
      // the AI SDK's same-step concurrent-tool-call shape.
      const fast = host.run('fast', { timeoutMs: 100, memoryBytes: 1000 })
      await flushMicrotasks()

      // Never reply to 'slow': let its own timeout (timeoutMs + RUN_GRACE_MS)
      // fire for real.
      await vi.advanceTimersByTimeAsync(100 + 2_000 + 50)
      await expect(slow).rejects.toThrow(/stopped responding|torn down/)

      // The sandbox was torn down and rebuilt — service the resulting
      // re-boot, then 'fast' should get to post its OWN exec:run and run to
      // a normal, successful completion, not die alongside 'slow'.
      await completeBoot(sandbox)
      const fastRun = findRun(sandbox, 'fast')
      sandbox.reply(fastRun.requestId, { ok: true, outcome: outcome('fast-result') })
      const result = await fast
      expect(result.value).toBe('fast-result')
    } finally {
      sandbox.restore()
      vi.useRealTimers()
    }
  })

  it('destroy() while a call is queued (not yet posted) does not reject it — it gets a fresh attempt instead', async () => {
    vi.useFakeTimers()
    const sandbox = fakeSandbox()
    try {
      const host = new ExecHost()
      const slow = host.run('slow', { timeoutMs: 100, memoryBytes: 1000 })
      slow.catch(() => {}) // see note in the previous test — avoids a spurious unhandled-rejection warning
      await completeBoot(sandbox)
      const queued = host.run('queued', { timeoutMs: 100, memoryBytes: 1000 })
      await flushMicrotasks()

      // 'queued' must not have posted anything yet — it's still waiting for
      // 'slow' to finish, which is the whole point of the fix.
      expect(sandbox.posted.some((m) => m.type === 'exec:run' && m.code === 'queued')).toBe(false)

      await vi.advanceTimersByTimeAsync(100 + 2_000 + 50)
      await expect(slow).rejects.toThrow()

      await completeBoot(sandbox)
      const queuedRun = findRun(sandbox, 'queued')
      sandbox.reply(queuedRun.requestId, { ok: true, outcome: outcome('queued-result') })
      expect((await queued).value).toBe('queued-result')
    } finally {
      sandbox.restore()
      vi.useRealTimers()
    }
  })
})
