import { test, describe, it, expect } from 'vitest'
import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import DOMPurify from 'dompurify'
import {
  encodeCitations,
  replaceCitationSentinels,
  citationsToPlain,
  escapeAttr,
  CITE_OPEN,
  CITE_CLOSE,
} from './citations'
import { normalizeMathDelimiters } from './mathDelimiters'
import { validateMath } from './mathValidate'

marked.use(markedKatex({ throwOnError: false, output: 'htmlAndMathml' }))

test('encodeCitations swaps [[n]] for private-use sentinels, leaving literal [n] alone', () => {
  const out = encodeCitations('A fact [[1]] and a quote "[2]" and cluster [[1]][[2]].')
  expect(out).toBe(`A fact ${CITE_OPEN}1${CITE_CLOSE} and a quote "[2]" and cluster ${CITE_OPEN}1${CITE_CLOSE}${CITE_OPEN}2${CITE_CLOSE}.`)
})

test('replaceCitationSentinels renders each n and handles adjacent clusters', () => {
  const encoded = encodeCitations('x [[1]][[2]] y')
  const out = replaceCitationSentinels(encoded, (n) => `<c>${n}</c>`)
  expect(out).toBe('x <c>1</c><c>2</c> y')
})

test('replaceCitationSentinels only fires on sentinels, not raw brackets', () => {
  const out = replaceCitationSentinels('plain [[1]] text', () => 'X')
  expect(out).toBe('plain [[1]] text') // not encoded → untouched
})

test('citationsToPlain degrades [[n]] to [n] for copy/fallback', () => {
  expect(citationsToPlain('a [[1]] b [[23]] c')).toBe('a [1] b [23] c')
})

test('escapeAttr neutralizes quote/angle/amp', () => {
  expect(escapeAttr('a"b<c>&d')).toBe('a&quot;b&lt;c&gt;&amp;d')
})

test('4+ digit citation numbers are intentionally left unencoded (F7, documented 3-digit cap)', () => {
  // [[1000]] doesn't match \d{1,3}, so it's left as raw markdown source rather
  // than degrading to a plain [1000]-style fallback. Only reachable if a
  // report accumulates 1000+ sources — documenting the current, intentional
  // bound explicitly so a future change to it is a deliberate decision.
  expect(encodeCitations('see [[1000]]')).toBe('see [[1000]]')
})

const SOURCES = [{ url: 'https://example.com', title: 'Example' }]

/** Mirrors citationHtml() in Markdown.tsx exactly (kept in sync by hand — the
 *  component itself isn't unit-testable, .tsx files aren't collected). */
function citationHtml(n: number, citations: { url: string; title: string }[]): string {
  const c = citations[n - 1]
  if (!c || !/^https?:\/\//i.test(c.url)) return `[${n}]`
  const href = escapeAttr(c.url)
  const title = escapeAttr(c.title || c.url)
  return `<a class="cite" href="${href}" target="_blank" rel="noreferrer" title="${title}"><img class="cite-favicon" src="fav.png" alt="" width="14" height="14" loading="lazy" /></a>`
}

/** Mirrors Markdown.tsx's full FINAL (non-streaming) render sequence exactly,
 *  with citations always enabled — the pipeline F1/F2 (d12) live in the seam
 *  between encodeCitations (pre-marked) and replaceCitationSentinels
 *  (post-sanitize). Real marked/marked-katex-extension/DOMPurify, not a stub. */
function render(text: string, citations: { url: string; title: string }[] = SOURCES): string {
  const src = encodeCitations(text)
  const normalized = normalizeMathDelimiters(src)
  const safe = validateMath(normalized).cleaned
  const raw = marked.parse(safe, { async: false }) as string
  const clean = DOMPurify.sanitize(raw, { ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['encoding'] })
  return replaceCitationSentinels(clean, (n) => citationHtml(n, citations))
}

describe('citations through the real render pipeline (marked + DOMPurify)', () => {
  it('still linkifies [[n]] in ordinary prose (control case)', () => {
    const html = render('A fact [[1]] here.')
    expect(html).toContain('<a class="cite"')
  })

  it('does not linkify [[n]] inside inline code (F1)', () => {
    const html = render('Use the syntax `[[1]]` to cite a source.')
    expect(html).not.toContain('<a class="cite"')
    expect(html).toContain('<code>[[1]]</code>')
  })

  it('does not linkify [[n]] inside a fenced code block (F1)', () => {
    const html = render('```\nSee [[1]] for details.\n```')
    expect(html).not.toContain('<a class="cite"')
    expect(html).toContain('[[1]]')
  })

  it('does not linkify [[n]] inside a fenced block that documents the citation syntax itself', () => {
    // The exact failure scenario from the audit: a report explaining its own
    // citation format inside a code sample.
    const html = render('Cite like this:\n```\n[[1]]\n```\n')
    expect(html).not.toContain('<a class="cite"')
  })

  it('[[n]] inside markdown link text does not produce a nested <a> (F2)', () => {
    const html = render('As reported by [TechCrunch[[1]]](https://techcrunch.com/article).')
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const anchors = doc.querySelectorAll('a')
    expect(anchors.length).toBe(1) // exactly one <a> — no nested <a class="cite">
    expect(anchors[0].getAttribute('href')).toBe('https://techcrunch.com/article')
    expect(anchors[0].textContent).toContain('TechCrunch')
  })
})
