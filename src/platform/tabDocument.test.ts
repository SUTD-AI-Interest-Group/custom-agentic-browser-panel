import { describe, it, expect } from 'vitest'
import { classifyTabDocument, type TabProbe } from './tabDocument'

const probe = (p: Partial<TabProbe> & { url: string }): TabProbe => ({ embeds: [], ...p })

describe('classifyTabDocument', () => {
  it('calls a tab a PDF from its content type, whatever the URL looks like', () => {
    // The case that is silently broken today: arXiv serves application/pdf from
    // a path with no .pdf suffix, so the URL heuristic alone misses it.
    const d = classifyTabDocument(
      probe({ url: 'https://arxiv.org/pdf/1706.03762', contentType: 'application/pdf', textLength: 0 }),
    )
    expect(d.kind).toBe('pdf')
    expect(d.pdfUrl).toBe('https://arxiv.org/pdf/1706.03762')
  })

  it('tolerates content-type parameters and casing', () => {
    // Observed from w3.org in a real browser: "application/pdf; qs=0.001".
    for (const ct of ['application/pdf; qs=0.001', 'Application/PDF', ' application/pdf ', 'application/x-pdf']) {
      expect(classifyTabDocument(probe({ url: 'https://x.test/a', contentType: ct })).kind, ct).toBe('pdf')
    }
  })

  it('falls back to the URL suffix when the content type is unknown', () => {
    // Injection can fail (no file access, restricted page) and still leave a URL.
    expect(classifyTabDocument(probe({ url: 'https://x.test/paper.pdf' })).kind).toBe('pdf')
    expect(classifyTabDocument(probe({ url: 'https://x.test/paper.pdf?dl=1#p2' })).kind).toBe('pdf')
    expect(classifyTabDocument(probe({ url: 'https://x.test/article' })).kind).toBe('html')
  })

  it('does not call an HTML page a PDF just because "pdf" appears in the URL', () => {
    const d = classifyTabDocument(
      probe({ url: 'https://x.test/pdf/guide', contentType: 'text/html', textLength: 900 }),
    )
    expect(d.kind).toBe('html')
  })

  it('finds a PDF embedded in an HTML page and returns its absolute URL', () => {
    // Verified in a real browser: for a CROSS-ORIGIN embedded PDF,
    // executeScript({allFrames:true}) never enumerates the PDF frame — scanning
    // the wrapper's own DOM is the only thing that recovers this URL.
    const d = classifyTabDocument(
      probe({
        url: 'https://lms.test/module7',
        contentType: 'text/html',
        textLength: 40,
        embeds: [{ tag: 'IFRAME', type: null, src: 'https://cdn.test/readings/week5.pdf' }],
      }),
    )
    expect(d.kind).toBe('pdf-embedded')
    expect(d.pdfUrl).toBe('https://cdn.test/readings/week5.pdf')
  })

  it('recognises an <embed>/<object> by its declared type, not just its suffix', () => {
    const d = classifyTabDocument(
      probe({
        url: 'https://lms.test/m',
        contentType: 'text/html',
        embeds: [{ tag: 'EMBED', type: 'application/pdf', src: 'https://cdn.test/download?id=99' }],
      }),
    )
    expect(d.kind).toBe('pdf-embedded')
    expect(d.pdfUrl).toBe('https://cdn.test/download?id=99')
  })

  it('reports every embedded PDF, first one first', () => {
    const d = classifyTabDocument(
      probe({
        url: 'https://lms.test/m',
        contentType: 'text/html',
        embeds: [
          { tag: 'IFRAME', type: null, src: 'https://cdn.test/a.pdf' },
          { tag: 'EMBED', type: 'application/pdf', src: 'https://cdn.test/b.pdf' },
        ],
      }),
    )
    expect(d.embedded).toEqual(['https://cdn.test/a.pdf', 'https://cdn.test/b.pdf'])
    expect(d.pdfUrl).toBe('https://cdn.test/a.pdf')
  })

  it('ignores an embedded PDF the panel could never fetch', () => {
    // A blob: URL belongs to the page's own origin; the side panel cannot fetch
    // it, so handing it to ReadPdf would dead-end. Better to stay 'html'.
    const d = classifyTabDocument(
      probe({
        url: 'https://viewer.test/doc',
        contentType: 'text/html',
        embeds: [{ tag: 'IFRAME', type: 'application/pdf', src: 'blob:https://viewer.test/9f2c' }],
      }),
    )
    expect(d.kind).toBe('html')
    expect(d.embedded).toEqual([])
  })

  it('de-duplicates the same file embedded twice', () => {
    // An <iframe> and an <embed> pointing at one file is a common fallback pattern.
    const d = classifyTabDocument(
      probe({
        url: 'https://lms.test/m',
        contentType: 'text/html',
        embeds: [
          { tag: 'IFRAME', type: null, src: 'https://cdn.test/a.pdf' },
          { tag: 'EMBED', type: 'application/pdf', src: 'https://cdn.test/a.pdf' },
        ],
      }),
    )
    expect(d.embedded).toEqual(['https://cdn.test/a.pdf'])
  })

  it('ignores embeds with no usable src', () => {
    const d = classifyTabDocument(
      probe({
        url: 'https://lms.test/m',
        contentType: 'text/html',
        embeds: [
          { tag: 'IFRAME', type: null, src: null },
          { tag: 'IFRAME', type: 'application/pdf', src: '' },
          { tag: 'IFRAME', type: null, src: 'https://ads.test/banner' },
        ],
      }),
    )
    expect(d.kind).toBe('html')
  })

  it('prefers the tab itself over its embeds when the tab IS the PDF', () => {
    const d = classifyTabDocument(
      probe({
        url: 'https://x.test/paper.pdf',
        contentType: 'application/pdf',
        embeds: [{ tag: 'EMBED', type: 'application/pdf', src: 'https://other.test/b.pdf' }],
      }),
    )
    expect(d.kind).toBe('pdf')
    expect(d.pdfUrl).toBe('https://x.test/paper.pdf')
  })

  it('never claims a PDF for a plain page', () => {
    const d = classifyTabDocument(
      probe({ url: 'https://news.test/story', contentType: 'text/html', textLength: 5000 }),
    )
    expect(d).toEqual({ kind: 'html', embedded: [] })
  })
})
