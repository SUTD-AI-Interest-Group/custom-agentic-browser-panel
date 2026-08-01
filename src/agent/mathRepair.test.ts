import { describe, it, expect } from 'vitest'
import { buildRepairPrompt, parseFixes, spliceFixes } from './mathRepair'
import { repairMessageText } from './mathRepair'
import type { MathSpan } from '../ui/mathValidate'

const span = (raw: string, start: number, end: number, display = false): MathSpan => ({
  raw,
  start,
  end,
  display,
})

describe('buildRepairPrompt', () => {
  it('numbers each broken fragment', () => {
    const p = buildRepairPrompt([span('$|sigma$', 0, 8), span('$$bad$$', 9, 16, true)])
    expect(p).toContain('1. $|sigma$')
    expect(p).toContain('2. $$bad$$')
  })
})

describe('parseFixes', () => {
  const spans = [span('$|sigma$', 6, 14)]

  it('accepts a valid, compilable fix keyed by original raw', () => {
    const fixes = parseFixes('[{"index":1,"fixed":"$\\\\sigma$"}]', spans)
    expect(fixes.get('$|sigma$')).toBe('$\\sigma$')
  })

  it('drops a fix that itself will not compile', () => {
    // The returned "fix" has an unbalanced brace, so validateMath rejects it.
    const fixes = parseFixes('[{"index":1,"fixed":"$\\\\frac{a}{$"}]', spans)
    expect(fixes.size).toBe(0)
  })

  it('returns an empty map on non-JSON output', () => {
    expect(parseFixes('sorry I cannot help', spans).size).toBe(0)
  })

  it('tolerates prose around the JSON array', () => {
    const fixes = parseFixes('Here you go:\n[{"index":1,"fixed":"$\\\\sigma$"}]\nDone', spans)
    expect(fixes.get('$|sigma$')).toBe('$\\sigma$')
  })

  it('drops a fix that dropped its $ delimiters (would leak raw LaTeX)', () => {
    const fixes = parseFixes('[{"index":1,"fixed":"\\\\sigma"}]', spans)
    expect(fixes.size).toBe(0)
  })

  // d01 F3: isWholeMathSpan's "dropped delimiters" guard did a blunt substring
  // check for ANY $ in the fix's inner content, rejecting a perfectly valid,
  // KaTeX-compiling fix that legitimately contains an escaped `\$` (e.g. a
  // currency sign inside math). It must only reject an UNESCAPED bare $.
  it('accepts a valid fix that legitimately contains an escaped \\$', () => {
    const fixes = parseFixes('[{"index":1,"fixed":"$a + \\\\$5$"}]', spans)
    expect(fixes.get('$|sigma$')).toBe('$a + \\$5$')
  })
})

describe('spliceFixes', () => {
  it('replaces spans right-to-left so offsets stay valid', () => {
    const text = 'a $|x$ b $|y$ c'
    const spans = [span('$|x$', 2, 6), span('$|y$', 9, 13)]
    const fixes = new Map([
      ['$|x$', '$x$'],
      ['$|y$', '$y$'],
    ])
    expect(spliceFixes(text, spans, fixes)).toBe('a $x$ b $y$ c')
  })

  it('leaves spans with no fix unchanged', () => {
    const text = 'a $|x$ b'
    const spans = [span('$|x$', 2, 6)]
    expect(spliceFixes(text, spans, new Map())).toBe('a $|x$ b')
  })
})

describe('repairMessageText', () => {
  it('returns text unchanged when all math is already valid', async () => {
    const text = 'clean $x=1$ and $$y=2$$'
    let called = false
    const fixed = await repairMessageText(text, async () => {
      called = true
      return ''
    })
    expect(fixed).toBe(text)
    expect(called).toBe(false) // no model call when nothing is broken
  })

  it('splices in a valid fix from the model', async () => {
    const text = 'width $\\frac{a}{$ here'
    const complete = async () => '[{"index":1,"fixed":"$\\\\sigma$"}]'
    expect(await repairMessageText(text, complete)).toBe('width $\\sigma$ here')
  })

  it('keeps the original when the model output is unusable', async () => {
    const text = 'width $\\frac{a}{$ here'
    expect(await repairMessageText(text, async () => 'no json here')).toBe(text)
  })

  it('keeps the original when the model call throws', async () => {
    const text = 'width $\\frac{a}{$ here'
    const complete = async () => {
      throw new Error('network')
    }
    expect(await repairMessageText(text, complete)).toBe(text)
  })

  it('does not regress: rejects a splice that leaves more broken spans', async () => {
    const text = 'width $\\frac{a}{$ here'
    // A "fix" that parses+compiles individually but we simulate no improvement:
    // return an empty array so no fix applies -> original preserved.
    expect(await repairMessageText(text, async () => '[]')).toBe(text)
  })

  it('keeps the original when the model drops the delimiters', async () => {
    const text = 'width $\\frac{a}{$ here'
    expect(await repairMessageText(text, async () => '[{"index":1,"fixed":"\\\\sigma"}]')).toBe(text)
  })

  // F4 (d12): validateMath's SCAN only recognizes $…$/$$…$$ — it is
  // structurally blind to \(...\)/\[...\], the delimiter style OpenAI-family
  // models emit (mathDelimiters.ts's own header comment). Before this fix,
  // repairMessageText called validateMath directly on the raw, un-normalized
  // text, so it never even detected this class of broken math — `invalid` was
  // empty and `complete()` was never called, regardless of what Chat.tsx's
  // calling filter decided.
  it('detects and repairs broken \\(...\\) math (OpenAI-style delimiters)', async () => {
    const text = 'The formula is \\(\\frac{a}{\\) end.'
    let called = false
    const complete = async () => {
      called = true
      return '[{"index":1,"fixed":"$\\\\frac{a}{b}$"}]'
    }
    const fixed = await repairMessageText(text, complete)
    expect(called).toBe(true)
    expect(fixed).toBe('The formula is $\\frac{a}{b}$ end.')
  })

  it('detects and repairs broken \\[...\\] display math (OpenAI-style delimiters)', async () => {
    const text = 'Total:\n\\[\\frac{a}{\\]\nend'
    let called = false
    const complete = async () => {
      called = true
      return '[{"index":1,"fixed":"$$\\\\frac{a}{b}$$"}]'
    }
    const fixed = await repairMessageText(text, complete)
    expect(called).toBe(true)
    expect(fixed).toContain('$$\\frac{a}{b}$$')
  })

  it('leaves \\(...\\) math untouched when it already compiles', async () => {
    const text = 'The value \\(x^2\\) is fine.'
    let called = false
    const fixed = await repairMessageText(text, async () => {
      called = true
      return ''
    })
    expect(called).toBe(false)
    expect(fixed).toBe(text)
  })
})
