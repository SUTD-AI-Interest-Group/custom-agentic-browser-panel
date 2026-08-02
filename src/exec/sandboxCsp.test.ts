// Guards the artifact-rendering sandbox's CSP. An audit found the meta CSP in
// public/sandbox-exec.html set only `connect-src 'none'` — per CSP semantics
// an unset directive not covered by `default-src` is unrestricted, so
// img-src/form-action/script-src were all wide open despite three separate
// code comments and the CreateArtifact tool description asserting "no
// network." A real-Chromium repro confirmed a remote <script src> loads AND
// executes, and <img>/<form> both reach an external server.
//
// public/sandbox-exec.html is a static asset with no module boundary to
// import, so this test reads and parses it directly — into a directive map,
// not a substring check, so a future edit can't silently widen one directive
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
const HTML_PATH = join(dirname(HERE), '../../public/sandbox-exec.html')

function readCsp(): Record<string, string[]> {
  const html = readFileSync(HTML_PATH, 'utf-8')
  const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)
  if (!match) throw new Error('no CSP meta tag found in public/sandbox-exec.html')
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
    const csp = readCsp()
    expect(csp['default-src']).toEqual(["'none'"])
  })

  it('blocks the network-facing directives the audit found wide open', () => {
    const csp = readCsp()
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
    const csp = readCsp()
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

  it('keeps connect-src closed (network calls stay blocked)', () => {
    const csp = readCsp()
    // Fine whether it's explicit or inherited from default-src 'none' — but
    // if present, it must not be reopened.
    if (csp['connect-src']) expect(csp['connect-src']).toEqual(["'none'"])
  })
})
