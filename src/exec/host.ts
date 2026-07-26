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
