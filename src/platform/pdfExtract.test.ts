import { describe, it, expect } from 'vitest'
import { splitPageMarkers, stripMarkdown, toPageTexts, pdfErrorMessage, scannedNote } from './pdfExtract'

describe('splitPageMarkers', () => {
  it('splits marker-delimited markdown into 1-based pages in order', () => {
    const md = '<!-- Page 1 -->\n\nfirst\n\n<!-- Page 2 -->\n\nsecond\n\n<!-- Page 3 -->\n\nthird'
    expect(splitPageMarkers(md, 3)).toEqual(['first', 'second', 'third'])
  })

  it('always returns exactly pageCount entries, padding pages with no content', () => {
    // pdf-inspector emits no body for a blank page; the pdf.js path pushed an
    // entry per page regardless, and every consumer indexes by page number.
    const md = '<!-- Page 1 -->\n\nfirst\n\n<!-- Page 3 -->\n\nthird'
    expect(splitPageMarkers(md, 4)).toEqual(['first', '', 'third', ''])
  })

  it('folds text before the first marker into page 1 rather than dropping it', () => {
    const md = 'stray preamble\n\n<!-- Page 1 -->\n\nbody'
    expect(splitPageMarkers(md, 1)).toEqual(['stray preamble\n\nbody'])
  })

  it('treats a document with no markers at all as a single page', () => {
    expect(splitPageMarkers('just some text', 1)).toEqual(['just some text'])
  })

  it('ignores markers pointing outside the page range instead of throwing', () => {
    const md = '<!-- Page 1 -->\na\n<!-- Page 9 -->\nb\n<!-- Page 0 -->\nc'
    expect(splitPageMarkers(md, 2)).toEqual(['a', ''])
  })

  it('accumulates a repeated marker instead of discarding the earlier text', () => {
    const md = '<!-- Page 1 -->\nfirst\n<!-- Page 1 -->\nagain'
    expect(splitPageMarkers(md, 1)).toEqual(['first\n\nagain'])
  })

  it('tolerates whitespace variation inside the marker', () => {
    expect(splitPageMarkers('<!--Page 1-->\na\n<!--   Page   2   -->\nb', 2)).toEqual(['a', 'b'])
  })

  it('returns an empty list for a zero/negative page count', () => {
    expect(splitPageMarkers('anything', 0)).toEqual([])
    expect(splitPageMarkers('anything', -3)).toEqual([])
  })
})

describe('stripMarkdown', () => {
  it('strips bold that splits a phrase — the measured search regression', () => {
    // pdf.js finds this phrase on page 3 of the Transformer paper; pdf-inspector
    // renders it "**Encoder:** The encoder…", which a literal search misses.
    const md = '**Encoder:** The encoder is composed of a stack of *N* = 6 identical layers.'
    const plain = stripMarkdown(md)
    expect(plain).toBe('Encoder: The encoder is composed of a stack of N = 6 identical layers.')
    expect(plain.toLowerCase()).toContain('encoder: the encoder is composed of a stack of')
  })

  it('strips heading markers but keeps the heading text', () => {
    expect(stripMarkdown('## 3.1 Encoder and Decoder Stacks')).toBe('3.1 Encoder and Decoder Stacks')
    expect(stripMarkdown('##### Scaled Dot-Product Attention')).toBe('Scaled Dot-Product Attention')
  })

  it('handles all three emphasis widths and both delimiters', () => {
    expect(stripMarkdown('***a*** **b** *c* ___d___ __e__ _f_')).toBe('a b c d e f')
  })

  it('leaves a lone asterisk or underscore alone', () => {
    // A dangling * is a footnote marker or a multiplication sign, not emphasis.
    expect(stripMarkdown('a * b')).toBe('a * b')
    expect(stripMarkdown('Vaswani *∗* Google')).toBe('Vaswani ∗ Google')
    expect(stripMarkdown('call foo_bar_baz(x)')).toBe('call foo_bar_baz(x)')
  })

  it('unwraps links and images to their visible text', () => {
    expect(stripMarkdown('see [the paper](https://arxiv.org/abs/1706.03762) now')).toBe('see the paper now')
    expect(stripMarkdown('![Figure 1](img.png)')).toBe('Figure 1')
  })

  it('flattens a table to its cell text and drops the separator row', () => {
    const md = '| Model | BLEU |\n|-------|------|\n| Transformer | 28.4 |'
    expect(stripMarkdown(md)).toBe('Model BLEU\nTransformer 28.4')
  })

  it('removes page markers and other HTML comments', () => {
    expect(stripMarkdown('<!-- Page 4 -->\nbody text')).toBe('body text')
  })

  it('keeps code content while dropping the fences and ticks', () => {
    expect(stripMarkdown('```python\nx = 1\n```')).toBe('x = 1')
    expect(stripMarkdown('the `softmax` function')).toBe('the softmax function')
  })

  it('keeps list bullets — they match neither the source glyph nor pdf.js either way', () => {
    expect(stripMarkdown('- first item\n- second item')).toBe('- first item\n- second item')
  })

  it('resolves backslash escapes markdown introduced', () => {
    expect(stripMarkdown('5 \\* 3 and a \\_name\\_')).toBe('5 * 3 and a _name_')
  })

  it('strips blockquote markers', () => {
    expect(stripMarkdown('> quoted line')).toBe('quoted line')
  })

  it('leaves interleaved math emphasis alone rather than guessing at the pairing', () => {
    // Real pdf-inspector output from p7 of the Transformer paper. `*warmup**steps*`
    // has no unambiguous pairing, so the paired-only rule declines. Deliberate:
    // corrupting a formula is worse than leaving syntax in text nobody quotes.
    expect(stripMarkdown('the first *warmup**steps* training steps')).toBe(
      'the first *warmup**steps* training steps',
    )
  })

  it('still strips cleanly paired emphasis that sits next to a math run', () => {
    expect(stripMarkdown('we used **4000** steps')).toBe('we used 4000 steps')
  })

  it('is a no-op on text that has no markdown in it', () => {
    const plain = 'The dominant sequence transduction models are based on complex recurrent networks.'
    expect(stripMarkdown(plain)).toBe(plain)
  })
})

describe('toPageTexts', () => {
  it('populates both the markdown and the stripped form per page', () => {
    const md = '<!-- Page 1 -->\n\n## Title\n\n**Bold** intro.\n\n<!-- Page 2 -->\n\nplain second page'
    expect(toPageTexts(md, 2)).toEqual([
      { page: 1, text: '## Title\n\n**Bold** intro.', plain: 'Title\n\nBold intro.' },
      { page: 2, text: 'plain second page', plain: 'plain second page' },
    ])
  })

  it('numbers pages 1-based and contiguously', () => {
    const pages = toPageTexts('<!-- Page 1 -->\na\n<!-- Page 2 -->\nb\n<!-- Page 3 -->\nc', 3)
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3])
  })
})

describe('pdfErrorMessage', () => {
  // The left column is what the WASM actually threw, captured empirically.
  it.each([
    ['process PDF: Not a PDF: file is not a PDF', 'This file is not a PDF.'],
    ['process PDF: Not a PDF: file appears to be HTML', 'This URL returned a web page, not a PDF.'],
    ['process PDF: Not a PDF: file is empty', 'This PDF is empty (zero bytes).'],
  ])('maps %s', (raw, expected) => {
    expect(pdfErrorMessage(raw)).toBe(expected)
  })

  it('keeps the password wording the pdf.js path used', () => {
    expect(pdfErrorMessage('process PDF: PDF is encrypted, password required')).toBe(
      'This PDF is password-protected and cannot be read.',
    )
  })

  it('passes an unrecognised failure through with its detail intact', () => {
    expect(pdfErrorMessage('process PDF: Invalid PDF structure')).toBe(
      'Could not parse this PDF (Invalid PDF structure).',
    )
  })

  it('survives a message with no prefix at all', () => {
    expect(pdfErrorMessage('something odd')).toBe('Could not parse this PDF (something odd).')
    expect(pdfErrorMessage('')).toBe('Could not parse this PDF (unknown error).')
  })
})

describe('scannedNote', () => {
  const clean = { pdfType: 'TextBased' as const, pagesNeedingOcr: [], hasEncodingIssues: false }

  it('says nothing when every requested page has a text layer', () => {
    expect(scannedNote(clean, [1, 2, 3])).toBeNull()
  })

  it('names the exact pages when only some need eyes', () => {
    const note = scannedNote({ ...clean, pdfType: 'Mixed', pagesNeedingOcr: [2, 5] }, [1, 2, 3])
    expect(note).toContain('Page 2')
    expect(note).not.toContain('Page 5') // not requested — don't volunteer it
    expect(note).toContain('mode:"view"')
  })

  it('calls a fully scanned request what it is', () => {
    const note = scannedNote({ ...clean, pdfType: 'Scanned', pagesNeedingOcr: [1, 2] }, [1, 2])
    expect(note).toContain('scanned')
    expect(note).toContain('mode:"view"')
  })

  it('caps the page list so a mixed long document does not produce a wall of numbers', () => {
    const ocr = Array.from({ length: 40 }, (_, i) => i + 1)
    const requested = Array.from({ length: 100 }, (_, i) => i + 1)
    const note = scannedNote({ ...clean, pdfType: 'Mixed', pagesNeedingOcr: ocr }, requested)!
    expect(note).toContain('1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, and 28 more')
    expect(note).not.toContain('13,')
  })

  it('flags broken font encoding ahead of the OCR list', () => {
    const note = scannedNote({ ...clean, hasEncodingIssues: true, pagesNeedingOcr: [1] }, [1])
    expect(note).toContain('decode badly')
  })
})
