// Guards the CreateArtifact tool description (tools.ts) and ArtifactCard's
// header comment against what public/sandbox-exec.html's CSP actually allows
// (src/exec/sandboxCsp.test.ts owns and guards that policy itself — this
// file only guards the PROSE describing it).
//
// Wave 1 tightened the sandbox CSP from a bare `connect-src 'none'` (which
// left img-src/form-action/script-src wide open — a remote <script src>
// loaded and EXECUTED) to `default-src 'none'` with three narrow, explicit
// allowances: inline <script>/<style>, and `data:` images. Both this tool's
// description and ArtifactCard's header comment predate that fix and still
// describe the OLD shape: neither mentions images at all (so a model reading
// the description has no idea whether an <img src="https://..."> silently
// fails or works), and the card's comment claimed a "scripts-only" isolation
// identical to RunCode's QuickJS sandbox — which is a different, stronger
// kind of isolation (no DOM/network primitives at all, regardless of any
// CSP) than this one (a real DOM page restricted by CSP). A tool description
// that overstates or omits what a sandbox allows is exactly how a model gets
// talked into generating an artifact that tries to phone home believing it
// won't, or avoids a perfectly safe data: image believing it can't.
//
// See fileURLToPath convention note in domIndex.test.ts: resolving a relative
// URL against import.meta.url as the base lands on http://localhost:3000/...
// under this project's vitest+jsdom setup, not the file:// path.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = fileURLToPath(import.meta.url)
const TOOLS_SRC = readFileSync(join(dirname(HERE), 'tools.ts'), 'utf-8')
const CARD_SRC = readFileSync(join(dirname(HERE), '../ui/ArtifactCard.tsx'), 'utf-8')

/** Pull the single-quoted `description:` string out of the `marker: tool({...})`
 *  block starting at `marker`, without needing a full TS parse. */
function extractDescription(src: string, marker: string): string {
  const at = src.indexOf(marker)
  if (at === -1) throw new Error(`marker not found in source: ${marker}`)
  const chunk = src.slice(at, at + 3000)
  const m = chunk.match(/description:\s*\n?\s*'((?:[^'\\]|\\.)*)'/)
  if (!m) throw new Error(`no description: '...' found near ${marker}`)
  return m[1]
}

describe('CreateArtifact description stays honest about the real sandbox CSP', () => {
  const desc = extractDescription(TOOLS_SRC, 'CreateArtifact: tool({')

  it('still asserts no network reaches anywhere remote', () => {
    expect(desc.toLowerCase()).toMatch(/no network/)
  })

  it('documents the one thing that now actually works: data: images', () => {
    // The CSP grants exactly one image allowance (img-src data:) beyond
    // default-src 'none'. Before this fix the description never mentioned
    // images at all, so a model had to guess.
    expect(desc).toMatch(/data:/i)
    expect(desc.toLowerCase()).toContain('image')
  })

  it('documents that cross-origin form submission is blocked', () => {
    // form-action 'none' is NOT covered by default-src per the CSP spec, so
    // it needed its own explicit allowance in sandbox-exec.html — the prose
    // should call it out too, the same way it already calls out scripts/fonts.
    // Word-boundary match: the description already contains "formatted
    // document" today, which must NOT satisfy this (that's a coincidental
    // substring, not documentation of the form-submission restriction).
    expect(desc.toLowerCase()).toMatch(/\bforms?\b/)
  })
})

describe("ArtifactCard's header comment stays honest about the real sandbox CSP", () => {
  const header = CARD_SRC.slice(0, CARD_SRC.indexOf('import'))

  it('does not claim a "scripts-only" isolation identical to RunCode\'s QuickJS sandbox', () => {
    // RunCode's QuickJS interpreter has no DOM/network primitives at all,
    // CSP-independent — a fundamentally different (and stronger) isolation
    // than this real-DOM-page-under-CSP sandbox. Conflating the two here
    // ("same isolation as code execution ... scripts-only nested iframe")
    // was accurate-sounding but wrong about *why* network is closed.
    expect(header.toLowerCase()).not.toContain('scripts-only')
  })

  it('mentions the data: image allowance', () => {
    expect(header).toMatch(/data:/i)
  })
})
