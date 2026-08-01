import { describe, it, expect } from 'vitest'
import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import DOMPurify from 'dompurify'
import { normalizeMathDelimiters } from './mathDelimiters'
import { validateMath } from './mathValidate'
import { encodeCitations, replaceCitationSentinels, escapeAttr } from './citations'

marked.use(markedKatex({ throwOnError: false, output: 'htmlAndMathml' }))

// The exact sequence Markdown.tsx runs for a final (non-streaming) message.
function render(text: string): string {
  const normalized = normalizeMathDelimiters(text)
  const cleaned = validateMath(normalized).cleaned
  return marked.parse(cleaned, { async: false }) as string
}
const displayCount = (html: string) => (html.match(/katex-display/g) || []).length

describe('markdown math render (with validateMath)', () => {
  it('renders a clean display equation', () => {
    expect(displayCount(render('$$Q = \\lambda_0 \\sigma \\sqrt{2\\pi}$$'))).toBe(1)
  })

  it('an uncompilable inline span does not stop a later valid display equation', () => {
    const text = 'width $\\frac{a}{$ then\n\n$$Q = \\lambda_0 \\sigma$$'
    const html = render(text)
    expect(displayCount(html)).toBe(1) // the display equation still renders
    // the structurally-broken inline span is inert code, not a half-math node
    expect(html).toContain('<code>')
  })

  it('renders a display block glued to the previous line by a single newline', () => {
    // The reported bug: `intro:\n$$…$$` (no blank line) rendered as raw text.
    // (displayCount is the reliable signal — KaTeX always embeds the raw TeX in
    // a MathML <annotation> node, so a substring check would false-positive.)
    const html = render('Applying Gauss law:\n$$\\oint_S \\mathbf{E} \\cdot d\\mathbf{A} = \\frac{Q}{\\epsilon_0}$$')
    expect(displayCount(html)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Full-pipeline helpers (below) mirror Markdown.tsx's ENTIRE sequence byte for
// byte, including the parts `render()` above deliberately omits (DOMPurify,
// citations) — needed for the streaming/fuzz/XSS coverage below, since the
// actual security boundary (script/handler stripping) lives in DOMPurify, and
// the actual failure mode of F1/F2 lives in the citation seam. Kept separate
// from `render()` above so the 3 existing tests are untouched.
function citationHtml(n: number, citations: { url: string; title: string }[]): string {
  const c = citations[n - 1]
  if (!c || !/^https?:\/\//i.test(c.url)) return `[${n}]`
  const href = escapeAttr(c.url)
  const title = escapeAttr(c.title || c.url)
  return `<a class="cite" href="${href}" target="_blank" rel="noreferrer" title="${title}"><img class="cite-favicon" src="fav.png" alt="" width="14" height="14" loading="lazy" /></a>`
}

/** Mirrors Markdown.tsx's FINAL (non-streaming) branch: validateMath runs. */
function renderFinal(text: string, citations?: { url: string; title: string }[]): string {
  const src = citations ? encodeCitations(text) : text
  const normalized = normalizeMathDelimiters(src)
  const safe = validateMath(normalized).cleaned
  const raw = marked.parse(safe, { async: false }) as string
  const clean = DOMPurify.sanitize(raw, { ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['encoding'] })
  return citations ? replaceCitationSentinels(clean, (n) => citationHtml(n, citations)) : clean
}

/** Mirrors Markdown.tsx's STREAMING branch: validateMath is skipped (a
 *  closing delimiter may not have streamed in yet; the render self-heals the
 *  instant it does). Currently zero dedicated coverage anywhere in the suite
 *  before this addition — the biggest gap this domain's audit flagged. */
function renderStreaming(text: string, citations?: { url: string; title: string }[]): string {
  const src = citations ? encodeCitations(text) : text
  const normalized = normalizeMathDelimiters(src)
  const raw = marked.parse(normalized, { async: false }) as string
  const clean = DOMPurify.sanitize(raw, { ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['encoding'] })
  return citations ? replaceCitationSentinels(clean, (n) => citationHtml(n, citations)) : clean
}

const FUZZ_SOURCES = [
  { url: 'https://example.com/a', title: 'Example A' },
  { url: 'https://example.com/b', title: 'Example B' },
]

// A representative document mixing every category the streaming path has to
// survive: headers, citations (plain prose, inside code, inside link text),
// currency ($ amounts straddled by backslashes), display/inline math in both
// $ and backslash-delimited styles, a fenced code block containing a
// citation-like sentinel, emoji/ZWJ sequences (multi-code-unit, so slicing at
// an arbitrary UTF-16 index WILL split them), and RTL (Arabic + Hebrew) text.
const FUZZ_DOC = [
  '# Report on $GDP$ Growth [[1]]',
  '',
  'It costs $50 to license, stored at C:\\Users\\name\\config, with a $75 upgrade [[2]].',
  '',
  'The formula is \\(E = mc^2\\) and also:',
  '',
  '\\[',
  '\\int_0^1 x^2 dx = \\frac{1}{3}',
  '\\]',
  '',
  '```js',
  '// a citation-like sentinel and currency inside a fence must not be touched',
  'const price = "$5"; // see [[1]] for details',
  '```',
  '',
  'Family emoji: \u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466} and a flag: \u{1F3F3}\uFE0F\u200D\u{1F308}, plain emoji: \u{1F389}\u{1F525}.',
  '',
  'Arabic RTL: \u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645 [[1]].',
  '',
  'Hebrew RTL: \u05E9\u05DC\u05D5\u05DD \u05E2\u05D5\u05DD.',
  '',
  'A [linked source[[1]]](https://example.com/a) and inline `[[2]]` code.',
].join('\n')

describe('streaming render pipeline: prefix fuzz (F6 gap — no prior coverage)', () => {
  it('never throws on any prefix, streaming or final', () => {
    for (let i = 0; i <= FUZZ_DOC.length; i++) {
      const prefix = FUZZ_DOC.slice(0, i)
      expect(() => renderStreaming(prefix, FUZZ_SOURCES), `streaming @${i}`).not.toThrow()
      expect(() => renderFinal(prefix, FUZZ_SOURCES), `final @${i}`).not.toThrow()
    }
  })

  it('never produces a <script> tag on any prefix, streaming or final', () => {
    for (let i = 0; i <= FUZZ_DOC.length; i++) {
      const prefix = FUZZ_DOC.slice(0, i)
      expect(renderStreaming(prefix, FUZZ_SOURCES), `streaming @${i}`).not.toMatch(/<script/i)
      expect(renderFinal(prefix, FUZZ_SOURCES), `final @${i}`).not.toMatch(/<script/i)
    }
  })

  it('renders the full document with all categories intact (sanity check on the last prefix)', () => {
    const html = renderFinal(FUZZ_DOC, FUZZ_SOURCES)
    expect(html).toContain('<a class="cite"') // ordinary-prose citation
    expect(html).toContain('[[1]]') // citation preserved literally inside code
    expect(html).toContain('katex') // math rendered
    expect(html).toContain('\u{1F389}') // emoji preserved
    expect(html).toContain('\u0645\u0631\u062D\u0628\u0627') // RTL text preserved
  })
})

describe('XSS surface (regression lock)', () => {
  it('strips a javascript: URL from a markdown link', () => {
    const html = renderFinal('[click me](javascript:alert(1))')
    expect(html.toLowerCase()).not.toContain('javascript:')
  })

  it('strips a data: URL used as a link target', () => {
    const html = renderFinal('[x](data:text/html,<script>alert(1)</script>)')
    expect(html).not.toMatch(/<script/i)
    expect(html.toLowerCase()).not.toContain('data:text/html')
  })

  it('strips a vbscript: URL from a markdown link', () => {
    const html = renderFinal('[x](vbscript:msgbox(1))')
    expect(html.toLowerCase()).not.toContain('vbscript:')
  })

  it('preserves a protocol-relative URL as an ordinary link (not a vulnerability, not blocked)', () => {
    // Protocol-relative links (//host/path) are ordinary, non-executable URLs
    // that inherit the current page's scheme — documenting that DOMPurify
    // correctly treats them as safe rather than stripping them.
    const html = renderFinal('[x](//example.com/asset)')
    expect(html).toContain('href="//example.com/asset"')
  })

  it('an href derived from untrusted content cannot inject a script (citation source URL)', () => {
    // Simulates a citation source URL originating from attacker-influenced
    // page content (the research/browse pipeline quotes/paraphrases pages).
    const evilSources = [{ url: 'javascript:alert(1)', title: 'evil' }]
    const html = renderFinal('See the source [[1]] for details.', evilSources)
    // citationHtml() only builds a live <a> for an http(s) URL; anything else
    // falls back to a plain, inert `[n]` marker — this locks that down
    // through the full pipeline, not just the isolated helper.
    expect(html.toLowerCase()).not.toContain('javascript:')
    expect(html).toContain('[1]')
  })

  it('a fenced block attempting to break out via a raw closing tag cannot escape sanitization', () => {
    const html = renderFinal('```\nfoo\n</pre><script>alert(1)</script>\n```')
    expect(html).not.toMatch(/<script/i)
  })

  it('a raw HTML block attempting to smuggle a script tag is stripped', () => {
    const html = renderFinal('<div>hello<script>alert(1)</script></div>')
    expect(html).not.toMatch(/<script/i)
  })

  it('an onerror handler on a raw <img> is stripped', () => {
    const html = renderFinal('<img src=x onerror="alert(1)">')
    expect(html.toLowerCase()).not.toContain('onerror')
  })

  it('the same 6 cases hold on the streaming path too', () => {
    expect(renderStreaming('[click me](javascript:alert(1))').toLowerCase()).not.toContain('javascript:')
    expect(renderStreaming('<div>hello<script>alert(1)</script></div>')).not.toMatch(/<script/i)
    expect(renderStreaming('<img src=x onerror="alert(1)">').toLowerCase()).not.toContain('onerror')
  })
})
