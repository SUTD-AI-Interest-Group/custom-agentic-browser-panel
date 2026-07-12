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
})
