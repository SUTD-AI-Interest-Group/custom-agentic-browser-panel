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
// config (`DOMPurify.sanitize(html, { FORBID_TAGS: ['iframe', 'form', 'svg'] })`,
// which only hooked `src|href|xlink:href|background|poster`) against the
// vectors below showed `srcset` (on both `<img>` and `<source>`) and inline
// `style="url(...)"` sailing through byte-for-byte unchanged — a live,
// zero-click exfiltration channel from the privileged side-panel origin.
// The fix replaces the denylist-of-known-bads with an explicit allowlist of
// tags/attributes (see mcpHtmlSanitize.ts's own header comment for the full
// policy and why each survivor is safe); this file now tests that policy
// adversarially and table-driven, not just the two originally-reported
// vectors.
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

  it('preserves ordinary table structure untouched', () => {
    const out = sanitizeMcpHtml('<table><tr><td>a</td><td>b</td></tr></table>')
    expect(out).toContain('<table>')
    expect(out).toContain('<td>a</td>')
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

// ---------------------------------------------------------------------------
// Table-driven: the full auto-fetch surface (S1). Each row is a vector that
// either DOES or does NOT initiate a network request the instant the
// sanitized string is parsed into the live DOM (McpContentCard's
// dangerouslySetInnerHTML) — no click involved. `evil.example` is the
// canary host; a passing "blocked" row must not contain it anywhere in the
// output (as a bare host, and — for the style-attribute/element cases —
// also not inside a surviving `style` attribute or `<style>` element, since
// a sanitizer could in principle drop the host from one context but leave
// the attribute/element itself intact for a *different* payload shape).
describe('sanitizeMcpHtml: the full auto-fetch surface (table-driven)', () => {
  const BLOCKED: Array<[name: string, html: string]> = [
    ['<img srcset> (comma-separated URL list, not a single-URL attribute)', '<img src="data:image/png;base64,AAAA" srcset="https://evil.example/k 1x">'],
    ['<source srcset> inside <video>', '<video><source srcset="https://evil.example/l" src="data:video/mp4;base64,AAAA"></video>'],
    ['<source srcset> inside <picture>', '<picture><source srcset="https://evil.example/w"><img src="data:image/png;base64,AAAA"></picture>'],
    ['imagesrcset (the <link> responsive-preload attribute, tried on <img>)', '<img src="data:image/png;base64,AAAA" imagesrcset="https://evil.example/x 1x">'],
    ['inline style="background:url(...)"', '<div style="background:url(https://evil.example/b)">x</div>'],
    ['inline style with @import', '<div style="@import url(https://evil.example/c)">x</div>'],
    // The style-attribute surface is not "background and a couple of other
    // named properties" — it's EVERY CSS property/function that can carry a
    // url(), which is why this file strips the whole `style` attribute
    // rather than denylisting property names (see the ALLOWED_ATTR comment
    // in mcpHtmlSanitize.ts). These rows exist so a future regression to a
    // property-name denylist — which would pass the two rows above while
    // still leaking every one of these — fails loudly.
    ['inline style -webkit-mask-image:url()', '<div style="-webkit-mask-image:url(https://evil.example/mask)">x</div>'],
    ['inline style content:url() (::before/::after image content)', '<div style="content:url(https://evil.example/content)">x</div>'],
    ['inline style list-style-image:url()', '<li style="list-style-image:url(https://evil.example/lsi)">x</li>'],
    ['inline style cursor:url()', '<div style="cursor:url(https://evil.example/cursor),auto">x</div>'],
    ['inline style border-image-source:url()', '<div style="border-image-source:url(https://evil.example/border)">x</div>'],
    ['inline style filter:url() (SVG filter resource reference)', '<div style="filter:url(https://evil.example/filter#f)">x</div>'],
    ['inline style clip-path:url() (SVG clip-path resource reference)', '<div style="clip-path:url(https://evil.example/clip#c)">x</div>'],
    ['inline style with a CSS comment between property and url() (obfuscation)', '<div style="background:/*x*/url(https://evil.example/comment)">x</div>'],
    ['<style> element (page-level CSS block)', '<style>div{background:url(https://evil.example/a)}</style><div>x</div>'],
    ['<style> element with @import', '<style>@import url(https://evil.example/c);</style>'],
    ['<style> element with -webkit-mask-image', '<style>div{-webkit-mask-image:url(https://evil.example/smask)}</style><div>x</div>'],
    ['<style> element with content:url()', '<style>div::before{content:url(https://evil.example/scontent)}</style><div>x</div>'],
    ['<link rel=stylesheet>', '<link rel="stylesheet" href="https://evil.example/d.css">'],
    ['<link rel=preload as=script>', '<link rel="preload" as="script" href="https://evil.example/e.js">'],
    ['<link rel=prefetch>', '<link rel="prefetch" href="https://evil.example/f">'],
    ['<link rel=dns-prefetch>', '<link rel="dns-prefetch" href="//evil.example">'],
    ['<link rel=icon>', '<link rel="icon" href="https://evil.example/favicon.ico">'],
    ['<meta http-equiv=refresh>', '<meta http-equiv="refresh" content="0;url=https://evil.example/g">'],
    ['<base href> (redirects every relative URL in the document)', '<base href="https://evil.example/">'],
    ['<object data>', '<object data="https://evil.example/h"></object>'],
    ['<embed src>', '<embed src="https://evil.example/i">'],
    ['<video><track src></video> (subtitle track fetch)', '<video><track src="https://evil.example/j.vtt"></video>'],
    ['<input type=image src> (image-button, fetches like <img>)', '<input type="image" src="https://evil.example/t">'],
    ['<input type=submit formaction>', '<input type="submit" formaction="https://evil.example/u">'],
    ['<a ping> (hidden click-beacon alongside a real link)', '<a href="https://example.com" ping="https://evil.example/m">click</a>'],
    ['<applet code>', '<applet code="https://evil.example/q"></applet>'],
    ['bare <image src> (HTML parser normalizes it to <img> before we ever see it)', '<image src="https://evil.example/o">'],
    ['xml:base then a relative <img src>', '<div xml:base="https://evil.example/"><img src="v"></div>'],
  ]

  it.each(BLOCKED)('blocks: %s', (_name, html) => {
    const out = sanitizeMcpHtml(html)
    expect(out).not.toContain('evil.example')
    expect(out).not.toMatch(/\bstyle\s*=/i) // no inline style ever survives, regardless of content
    expect(out).not.toMatch(/<style/i) // no <style> element ever survives
  })
})

// ---------------------------------------------------------------------------
// Mutation-XSS shapes: nested/namespace-confused parsing that has historically
// bypassed sanitizers by exploiting a gap between how the sanitizer's own DOM
// walk interprets a string and how the browser re-parses that SAME string via
// innerHTML (exactly what McpContentCard does with sanitizeMcpHtml's output).
// These render the sanitizer's real output through jsdom's innerHTML — the
// same re-parse McpContentCard performs — rather than only inspecting the
// returned string, since an mXSS bug by definition looks clean as a string
// and only misbehaves once re-parsed.
describe('sanitizeMcpHtml: mutation-XSS shapes (nested/namespace-confused parsing)', () => {
  const MXSS_PAYLOADS = [
    ['<svg> hosting a <style> hosting an onerror-bearing <img>', '<svg><style><img src=x onerror=alert(1)></style></svg>'],
    ['<math> hosting a nested <mtext> foreign-content boundary', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></mglyph></mtext></math>'],
    ['<template> hosting a <script>', '<template><script>alert(1)</script></template>'],
    ['<noscript> hosting a raw <img onerror>', '<noscript><img src=x onerror=alert(1)></noscript>'],
    ['select/option HTML-parsing quirk (Kinugawa-style mXSS)', '<select><style></select><img src=x onerror=alert(1)></style></select>'],
    ['<svg><foreignObject> hosting an <iframe>', '<svg><foreignObject><iframe src="https://evil.example"></iframe></foreignObject></svg>'],
    ['<xmp> raw-text smuggling', '<xmp><img src=x onerror=alert(1)></xmp>'],
    ['deeply nested forbidden tags carrying the payload in an attribute', '<svg><math><style><input type="image" src="https://evil.example/z" onerror="alert(1)"></style></math></svg>'],
  ] as const

  it.each(MXSS_PAYLOADS)('%s: the RE-PARSED output has no script/handler/canary', (_name, payload) => {
    const out = sanitizeMcpHtml(payload)
    // Re-parse exactly as McpContentCard does (dangerouslySetInnerHTML), so a
    // bug that only manifests on the browser's second parse is caught too.
    const div = document.createElement('div')
    div.innerHTML = out
    expect(div.querySelector('script')).toBeNull()
    expect(div.innerHTML).not.toMatch(/on\w+\s*=/i) // no event-handler attribute anywhere
    expect(div.innerHTML).not.toContain('evil.example')
    expect(div.innerHTML.toLowerCase()).not.toContain('alert(1)')
  })

  it.each(MXSS_PAYLOADS)('%s: sanitizing is idempotent (no second-pass mutation)', (_name, payload) => {
    // The hallmark of mXSS: a sanitizer's OWN output, fed back through itself,
    // sanitizes differently — meaning the first pass understated the danger.
    // A stable fixed point (sanitize(x) === sanitize(sanitize(x))) is a
    // standard mXSS self-check.
    const once = sanitizeMcpHtml(payload)
    const twice = sanitizeMcpHtml(once)
    expect(twice).toBe(once)
  })
})

// ---------------------------------------------------------------------------
// Hook-ordering / value-obfuscation robustness: the `uponSanitizeAttribute`
// hook must not be foolable by casing, whitespace, or substring tricks in the
// attribute name or value. Two of these lock down behavior that turns out to
// come from DOMPurify's OWN default URI handling (verified directly against
// a plain, unconfigured DOMPurify instance before writing these — see the
// comment on each) rather than this file's hook; they're kept here anyway
// since they're load-bearing for this file's `data:`-only guarantee and a
// future DOMPurify upgrade changing either would be worth catching.
describe('sanitizeMcpHtml: hook-ordering and value-obfuscation robustness', () => {
  it('blocks an uppercase SRC attribute name the same as lowercase (HTML parser normalizes tag/attr names before our hook ever runs)', () => {
    const out = sanitizeMcpHtml('<img SRC="https://evil.example/x">')
    expect(out).not.toContain('evil.example')
  })

  it('drops the whole attribute for an uppercase DATA:/mixed-case Data: scheme rather than treating it as data: (confirmed this is DOMPurify\'s own default `src`-scheme check, case-sensitive on "data:" specifically, independent of this file\'s hook — fails safe, not a bypass: the attribute is gone either way, never left holding a non-data value)', () => {
    expect(sanitizeMcpHtml('<img src="DATA:image/png;base64,AAAA">')).not.toMatch(/src\s*=/i)
    expect(sanitizeMcpHtml('<img src="Data:image/png;base64,AAAA">')).not.toMatch(/src\s*=/i)
  })

  it('rejects a value where "data:" appears but is not the scheme (anchored match, not a substring search)', () => {
    const out = sanitizeMcpHtml('<img src="javascript:alert(1)//data:">')
    expect(out).not.toContain('javascript:')
    // The whole point of anchoring: a naive `.includes('data:')` would have
    // wrongly kept this attribute because the substring is present.
    expect(out).not.toMatch(/src\s*=/i)
  })

  it('drops a data:-URI src that also carries an embedded, HTML-escaped payload — decoding happens before our hook runs, not after', () => {
    // `&#58;` is the HTML entity for `:`. If our hook ever saw the RAW,
    // pre-decode attribute text, "data&#58;" would fail the `^data:` regex
    // and the attribute would be (safely) dropped — a false rejection, not a
    // bypass. Confirms the opposite isn't true either: a non-data scheme
    // hidden behind entity-encoding doesn't sneak past as if it were data:.
    const out = sanitizeMcpHtml('<img src="javascript&#58;alert(1)">')
    expect(out).not.toContain('javascript:')
    expect(out).not.toMatch(/src\s*=/i)
  })

  it('a leading-whitespace data: value still resolves and is kept (confirmed this is DOMPurify\'s own default trimming of URI-bearing attribute values, ahead of this file\'s hook — still inert either way: a data: URI never touches the network regardless of incidental whitespace)', () => {
    const out = sanitizeMcpHtml('<img src="  data:image/png;base64,AAAA">')
    expect(out).toContain('data:image/png;base64,AAAA')
  })
})

// ---------------------------------------------------------------------------
// <a href> handling: the reviewer flagged that the previous fix deliberately
// left <a>/<area> alone (click-through, not auto-fetch) and asked this pass
// to confirm that exemption doesn't also let an executable scheme through.
describe('sanitizeMcpHtml: <a href> handling', () => {
  it('strips a javascript: href but keeps the link text', () => {
    const out = sanitizeMcpHtml('<a href="javascript:alert(1)">click me</a>')
    expect(out.toLowerCase()).not.toContain('javascript:')
    expect(out).toContain('click me')
  })

  it('strips a data: href used to smuggle an HTML document', () => {
    const out = sanitizeMcpHtml('<a href="data:text/html,<script>alert(1)</script>">click</a>')
    expect(out).not.toMatch(/<script/i)
    expect(out.toLowerCase()).not.toContain('data:text/html')
  })

  it('strips a vbscript: href', () => {
    const out = sanitizeMcpHtml('<a href="vbscript:msgbox(1)">click</a>')
    expect(out.toLowerCase()).not.toContain('vbscript:')
  })

  it('keeps an ordinary https:// href and its text intact', () => {
    const out = sanitizeMcpHtml('<a href="https://example.com/report?id=1">See the report</a>')
    expect(out).toContain('href="https://example.com/report?id=1"')
    expect(out).toContain('See the report')
  })

  it('keeps a mailto: href (an ordinary, non-executable click-through link)', () => {
    const out = sanitizeMcpHtml('<a href="mailto:help@example.com">email us</a>')
    expect(out).toContain('href="mailto:help@example.com"')
  })

  it('does not add target/rel to a plain link (no target admitted — see mcpHtmlSanitize.ts on why)', () => {
    const out = sanitizeMcpHtml('<a href="https://example.com" target="_blank">click</a>')
    expect(out).not.toContain('target')
    expect(out).toContain('href="https://example.com"')
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
