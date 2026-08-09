// Locks down the sandbox attribute on the external-URL MCP app iframe
// (McpAppCard.tsx's `app.externalUrl` branch — a `text/uri-list` template,
// so the framed URL is entirely server-chosen). A regex over the real
// source, not a full React render: same technique as
// src/tools/artifactSandboxCopy.test.ts and src/exec/sandboxCsp.test.ts,
// chosen because this repo has no React component test harness (no
// @testing-library dependency, no .tsx test anywhere) and a single JSX
// attribute string doesn't warrant introducing one.
//
// allow-same-origin was dropped here: it gave the server-chosen page full
// access to whatever real cookies/storage that origin already held in this
// browser profile, for no documented reason — every actual text/uri-list use
// in this codebase is a one-shot informational embed, and public/sandbox.html
// states the opposite rule ("allow-scripts only — never allow-same-origin")
// for the sibling case two lines below this one (the sandboxed app-HTML
// iframe). A page that genuinely needs a real login still works via
// allow-popups (a normal, non-sandboxed top-level window) or the "Open in a
// tab" fallback link rendered alongside this iframe.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = fileURLToPath(import.meta.url)
const SRC = readFileSync(join(dirname(HERE), 'McpAppCard.tsx'), 'utf-8')

/** Pull the `sandbox="..."` value off the iframe that immediately follows
 *  `marker` in source order, without needing a full JSX parse. */
function extractSandbox(src: string, marker: string): string {
  const at = src.indexOf(marker)
  if (at === -1) throw new Error(`marker not found in source: ${marker}`)
  const chunk = src.slice(at, at + 800)
  const m = chunk.match(/sandbox="([^"]*)"/)
  if (!m) throw new Error(`no sandbox="..." found near ${marker}`)
  return m[1]
}

describe('the external-URL MCP app iframe (text/uri-list — a server-chosen URL)', () => {
  const sandbox = extractSandbox(SRC, 'src={app.externalUrl}').split(/\s+/)

  it('never grants allow-same-origin to a server-chosen origin', () => {
    expect(sandbox).not.toContain('allow-same-origin')
  })

  it('still allows the app to actually run: scripts, forms, popups', () => {
    // Not a security assertion — just guarding against an over-correction
    // that silently breaks working MCP apps while fixing the same-origin gap.
    expect(sandbox).toEqual(expect.arrayContaining(['allow-scripts', 'allow-forms', 'allow-popups']))
  })
})
