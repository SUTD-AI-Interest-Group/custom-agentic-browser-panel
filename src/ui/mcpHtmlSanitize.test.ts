import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import DOMPurify from 'dompurify'
import { sanitizeMcpHtml } from './mcpHtmlSanitize'

// McpContentCard renders an MCP tool's "html"-kind result via
// dangerouslySetInnerHTML directly into the side panel's own live DOM — no
// sandboxed iframe, no restrictive CSP (the manifest sets none for
// extension_pages beyond MV3's script-src/object-src default). Unlike the
// CreateArtifact sandbox (a *different* code path, isolated by CSP), the
// ONLY thing standing between an MCP server's returned HTML and the
// extension's own network reachability is this sanitizer.
//
// Confirmed empirically before writing this fix: running the file's OLD
// config (`DOMPurify.sanitize(html, { FORBID_TAGS: ['iframe', 'form'] })`)
// against a battery of candidate vectors showed DOMPurify's own defaults
// already strip <script>, <style>, <link>, <base>, <meta>, <object>, and
// <embed> — but pass through <img src>, <video src>, <audio src>, and
// <svg><image href> completely unmodified, and a legacy <… background>
// attribute too. Every one of those fires an automatic network request the
// instant the card renders, without the user clicking anything — a silent
// exfiltration/beacon channel from a tool call the user approved running,
// not a result they approved auto-phoning-home.
describe('sanitizeMcpHtml', () => {
  it('strips a remote <img> src (auto-fetches on render, no click needed)', () => {
    const out = sanitizeMcpHtml('<img src="https://evil.example/beacon.png">')
    expect(out).not.toContain('evil.example')
  })

  it('keeps a data: <img> src (legitimate inline image, no network involved)', () => {
    const out = sanitizeMcpHtml('<img src="data:image/png;base64,AAAA">')
    expect(out).toContain('data:image/png;base64,AAAA')
  })

  it('strips a remote <video> src', () => {
    const out = sanitizeMcpHtml('<video src="https://evil.example/v.mp4"></video>')
    expect(out).not.toContain('evil.example')
  })

  it('strips a remote <audio> src', () => {
    const out = sanitizeMcpHtml('<audio src="https://evil.example/a.mp3"></audio>')
    expect(out).not.toContain('evil.example')
  })

  it('strips a <video poster> pointing at a remote host', () => {
    const out = sanitizeMcpHtml('<video src="data:video/mp4;base64,AAAA" poster="https://evil.example/p.png"></video>')
    expect(out).not.toContain('evil.example')
  })

  it('removes <svg> entirely (closes off <svg><image href>, <use>, <feImage>, etc. in one cut)', () => {
    const out = sanitizeMcpHtml('<svg><image href="https://evil.example/s.png"/></svg>')
    expect(out).not.toContain('evil.example')
    expect(out).not.toContain('<svg')
  })

  it('strips a legacy <table background> attribute pointing at a remote host', () => {
    const out = sanitizeMcpHtml('<table background="https://evil.example/t.png"><tr><td>x</td></tr></table>')
    expect(out).not.toContain('evil.example')
  })

  it('leaves a normal http(s) <a href> untouched — a click-through link is not an auto-fetch vector', () => {
    const out = sanitizeMcpHtml('<a href="https://example.com/report">See the full report</a>')
    expect(out).toContain('href="https://example.com/report"')
    expect(out).toContain('See the full report')
  })

  it('still forbids <iframe> and <form> (the pre-existing config)', () => {
    const out = sanitizeMcpHtml('<iframe src="https://evil.example"></iframe><form action="https://evil.example"></form>')
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<form')
  })

  it('still strips <script> and inline event handlers (DOMPurify defaults, locked down explicitly)', () => {
    const out = sanitizeMcpHtml('<script>alert(1)</script><div onclick="alert(1)">x</div>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onclick')
  })

  it('preserves ordinary formatted text content untouched', () => {
    const out = sanitizeMcpHtml('<h1>Report</h1><p>Some <strong>bold</strong> text.</p>')
    expect(out).toBe('<h1>Report</h1><p>Some <strong>bold</strong> text.</p>')
  })

  it('does not affect the shared default DOMPurify import used elsewhere (Markdown.tsx) — uses its own isolated instance', () => {
    // Regression guard for a real footgun: DOMPurify's default export is a
    // singleton; addHook on it would leak this file's stricter rules into
    // every other sanitize() call in the app (e.g. Markdown.tsx's citation/
    // math rendering) if this file used the shared instance instead of its
    // own. Importing the plain default and sanitizing the same remote <img>
    // must NOT be affected by whatever mcpHtmlSanitize.ts configured —
    // sanitizeMcpHtml must have called it as a *new* instance, not mutated
    // the shared singleton this test imports the normal way.
    const out = DOMPurify.sanitize('<img src="https://example.com/x.png">')
    expect(out).toContain('example.com')
  })
})

// Integration guard: McpContentCard.tsx must actually call sanitizeMcpHtml
// for its "html" kind, not the bare DOMPurify.sanitize(...) call this file
// replaces (which is the exact config the vulnerability above was found in).
describe('McpContentCard uses sanitizeMcpHtml for html-kind artifacts', () => {
  const HERE = fileURLToPath(import.meta.url)
  const SRC = readFileSync(join(dirname(HERE), 'McpContentCard.tsx'), 'utf-8')

  it('imports sanitizeMcpHtml and does not call DOMPurify directly', () => {
    expect(SRC).toMatch(/sanitizeMcpHtml/)
    expect(SRC).not.toMatch(/DOMPurify\.sanitize/)
  })
})
