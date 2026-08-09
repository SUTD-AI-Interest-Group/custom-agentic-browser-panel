// Guards the CSP of both manifest-sandboxed pages: the artifact-rendering
// sandbox (public/sandbox-exec.html) and the MCP Apps host (public/sandbox.html).
//
// sandbox-exec.html: an audit found the meta CSP set only `connect-src
// 'none'` — per CSP semantics an unset directive not covered by `default-src`
// is unrestricted, so img-src/form-action/script-src were all wide open
// despite three separate code comments and the CreateArtifact tool
// description asserting "no network." A real-Chromium repro confirmed a
// remote <script src> loads AND executes, and <img>/<form> both reach an
// external server. A SECOND real-Chromium repro (posting the actual bundled
// QuickJS wasm bytes through the real exec:init/exec:run protocol) found
// script-src was missing 'wasm-unsafe-eval': WebAssembly.instantiate()
// threw a CSP CompileError and RunCode was completely dead — exec:init
// failed and every exec:run afterward reported "engine not initialized".
// Adding 'wasm-unsafe-eval' (confirmed via the same repro) fixed it: the vm
// actually evaluates code again.
//
// sandbox.html: manifest.json declares no content_security_policy.sandbox
// override, so this page had NO meta CSP at all and ran under Chrome's MV3
// default sandbox CSP, which sets only script-src/child-src — connect-src
// and img-src stay completely open. A real-Chromium repro (loading real MCP
// app HTML into the nested srcdoc iframe exactly as the panel does) proved
// that app HTML could fetch()/XHR to an arbitrary origin and load a remote
// <img>, both actually reaching a local listener; only <form> submission was
// incidentally blocked by the default policy's child-src fallback, not by
// anything protecting the network-reaching directives. That's a narrower
// tracking/fingerprinting-shaped issue (an app already knows its own
// toolInput/toolResult — nothing secret crosses it) but it was inconsistent
// with sandbox-exec.html's explicit default-deny stance. A matching meta CSP
// was added; a further real-Chromium repro confirmed the same probes now hit
// zero network requests, AND that the actual mcp-app:load / mcp-app:rpc /
// mcp-app:rpc-response relay still works end-to-end (a full ui/initialize
// JSON-RPC handshake round-tripped correctly) — the tightened policy does
// not break MCP Apps.
//
// Both HTML files are static assets with no module boundary to import, so
// this test reads and parses them directly — into a directive map, not a
// substring check, so a future edit can't silently widen one directive
// while leaving an unrelated "default-src 'none'" substring intact elsewhere.
//
// See fileURLToPath convention note in domIndex.test.ts: resolving a relative
// URL against import.meta.url as the base lands on http://localhost:3000/...
// under this project's vitest+jsdom setup, not the file:// path.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = fileURLToPath(import.meta.url)
const EXEC_HTML_PATH = join(dirname(HERE), '../../public/sandbox-exec.html')
const APPS_HTML_PATH = join(dirname(HERE), '../../public/sandbox.html')

function readCsp(htmlPath: string): Record<string, string[]> {
  const html = readFileSync(htmlPath, 'utf-8')
  const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)
  if (!match) throw new Error(`no CSP meta tag found in ${htmlPath}`)
  const directives: Record<string, string[]> = {}
  for (const part of match[1].split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    directives[tokens[0]] = tokens.slice(1)
  }
  return directives
}

describe('sandbox-exec.html CSP', () => {
  it('default-denies everything not explicitly allowed', () => {
    const csp = readCsp(EXEC_HTML_PATH)
    expect(csp['default-src']).toEqual(["'none'"])
  })

  it('blocks the network-facing directives the audit found wide open', () => {
    const csp = readCsp(EXEC_HTML_PATH)
    // img-src: data: URIs only — no remote host, no scheme wildcard.
    expect(csp['img-src']).toEqual(['data:'])
    // form-action is NOT covered by default-src per the CSP spec (unlike
    // connect-src/script-src/img-src/etc.), so it must be listed explicitly
    // or a form in model-authored HTML could still submit anywhere.
    expect(csp['form-action']).toEqual(["'none'"])
    // script-src must not grant a remote host or a scheme wildcard.
    const scriptSrc = csp['script-src'] ?? []
    expect(scriptSrc.length).toBeGreaterThan(0)
    for (const source of scriptSrc) {
      expect(source).not.toMatch(/^https?:|^\*$|^\*\./)
    }
  })

  it('still allows what the sandbox itself needs: its own bundled script, inline script/style, and data: images', () => {
    const csp = readCsp(EXEC_HTML_PATH)
    // 'self' — the outer page's own <script src="sandbox-exec.js">. Without
    // this, restricting script-src at all silently breaks RunCode/artifact
    // rendering entirely (confirmed empirically: dropping 'self' here blocks
    // the sandbox's own bundled script with a CSP violation).
    expect(csp['script-src']).toContain("'self'")
    // 'unsafe-inline' — the whole point of CreateArtifact/UpdateArtifact is
    // inline script/style in model-authored HTML.
    expect(csp['script-src']).toContain("'unsafe-inline'")
    expect(csp['style-src']).toContain("'unsafe-inline'")
  })

  it("grants 'wasm-unsafe-eval' — without it QuickJS cannot instantiate at all", () => {
    const csp = readCsp(EXEC_HTML_PATH)
    // Confirmed via a real-Chromium repro that posted the actual bundled
    // wasm bytes through the real exec:init/exec:run protocol: without this
    // token, WebAssembly.instantiate() throws "neither 'wasm-eval' nor
    // 'unsafe-eval' is an allowed source of script", exec:init reports
    // ok:false, and every subsequent exec:run fails with "engine not
    // initialized" — RunCode is silently and completely dead. This is
    // narrower than 'unsafe-eval': it does not also grant eval()/Function().
    expect(csp['script-src']).toContain("'wasm-unsafe-eval'")
    // Guard against the broader token creeping in as a "fix" instead.
    expect(csp['script-src']).not.toContain("'unsafe-eval'")
  })

  it('keeps connect-src closed (network calls stay blocked)', () => {
    const csp = readCsp(EXEC_HTML_PATH)
    // Fine whether it's explicit or inherited from default-src 'none' — but
    // if present, it must not be reopened.
    if (csp['connect-src']) expect(csp['connect-src']).toEqual(["'none'"])
  })
})

describe('sandbox.html CSP (MCP Apps host)', () => {
  it('default-denies everything not explicitly allowed', () => {
    const csp = readCsp(APPS_HTML_PATH)
    expect(csp['default-src']).toEqual(["'none'"])
  })

  it('blocks the network-facing directives a real-Chromium repro found reachable under the previous no-CSP default', () => {
    const csp = readCsp(APPS_HTML_PATH)
    // Before this tag existed, app HTML in the nested srcdoc iframe could
    // fetch()/XHR to an arbitrary origin and load a remote <img> — both
    // confirmed reaching a real local listener. connect-src has no explicit
    // allowance here, so it must fall back to default-src 'none'.
    expect(csp['connect-src']).toBeUndefined()
    expect(csp['img-src']).toEqual(['data:'])
    expect(csp['form-action']).toEqual(["'none'"])
    const scriptSrc = csp['script-src'] ?? []
    expect(scriptSrc.length).toBeGreaterThan(0)
    for (const source of scriptSrc) {
      expect(source).not.toMatch(/^https?:|^\*$|^\*\./)
    }
  })

  it('still allows what the relay and app HTML need: inline script/style, no remote host', () => {
    const csp = readCsp(APPS_HTML_PATH)
    // This page's own relay <script> is inline (never a <script src>, per
    // its own comment — a sandboxed page's opaque origin fails CORS on a
    // module fetch), and it's what the nested srcdoc iframe's app HTML
    // needs too (srcdoc documents inherit their creator's CSP). Confirmed
    // via a real-Chromium repro: a full ui/initialize JSON-RPC handshake
    // (app -> relay -> host -> relay -> app) round-tripped correctly under
    // this exact policy, including the app's own inline <style>.
    expect(csp['script-src']).toContain("'unsafe-inline'")
    expect(csp['style-src']).toContain("'unsafe-inline'")
    // No wasm here — this page never runs QuickJS, unlike sandbox-exec.html.
    expect(csp['script-src']).not.toContain("'wasm-unsafe-eval'")
    expect(csp['script-src']).not.toContain("'unsafe-eval'")
  })
})
