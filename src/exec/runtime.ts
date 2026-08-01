// The sandbox-side entry, bundled as a classic IIFE into dist/sandbox-exec.js
// (see vite.sandbox.config.ts). Runs inside sandbox-exec.html: no chrome.*,
// default-deny CSP (see that file's meta tag for the exact allowances and why
// each is needed), parent-postMessage only. Two duties: execute code
// (exec:init + exec:run, via the engine) and preview artifact HTML
// (exec:render, in a nested scripts-only srcdoc iframe — never
// allow-same-origin). All policy (approval, budgets) lives in the panel.
//
// exec:render's nested iframe inherits the host page's CSP (srcdoc documents
// inherit their creator's policy), which is what actually contains a
// malicious/prompt-injected artifact — inline script/style and data: images
// still work, but a remote <script src>/<img src>/cross-origin <form> are all
// blocked before they ever reach the network (verified against a real
// Chromium instance).

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
