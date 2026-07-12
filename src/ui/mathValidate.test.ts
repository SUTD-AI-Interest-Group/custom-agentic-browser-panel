import { describe, it, expect } from 'vitest'
import { validateMath } from './mathValidate'

describe('validateMath', () => {
  it('leaves balanced inline and display math untouched', () => {
    const text = 'Peak at $x=0$ and\n\n$$Q = \\lambda_0 \\sigma \\sqrt{2\\pi}$$\n\ndone'
    const { cleaned, invalid } = validateMath(text)
    expect(invalid).toHaveLength(0)
    expect(cleaned).toBe(text)
  })

  it('neutralizes a structurally-invalid inline span as inline code and records it', () => {
    // KaTeX throws on an unbalanced brace (unlike loose text such as `|sigma`,
    // which it renders without error — see the notes on KaTeX leniency).
    const { cleaned, invalid } = validateMath('width $\\frac{a}{$ here')
    expect(invalid).toHaveLength(1)
    expect(invalid[0].raw).toBe('$\\frac{a}{$')
    expect(invalid[0].display).toBe(false)
    expect(cleaned).toBe('width `$\\frac{a}{$` here')
  })

  it('an uncompilable span is neutralized without stopping a later valid one', () => {
    const { cleaned, invalid } = validateMath('bad $\\frac{a}{$ then good $x=5$ end')
    expect(invalid).toHaveLength(1)
    expect(invalid[0].raw).toBe('$\\frac{a}{$')
    expect(cleaned).toContain('$x=5$') // the valid pair survives as math
    expect(cleaned).toContain('`$\\frac{a}{$`') // the bad one becomes inert code
  })

  it('escapes a lone trailing $ that never closes', () => {
    const { cleaned } = validateMath('cost is $5 today') // single unpaired $
    expect(cleaned).toBe('cost is \\$5 today')
  })

  it('never touches $ inside fenced or inline code, nor a literal \\$', () => {
    const fenced = '```\n$x$ not math\n```\ntext'
    expect(validateMath(fenced).cleaned).toBe(fenced)
    const inline = 'run `$PATH` here'
    expect(validateMath(inline).cleaned).toBe(inline)
    const literal = 'costs \\$5 flat'
    expect(validateMath(literal).cleaned).toBe(literal)
  })

  it('keeps a valid display integral while flagging a genuinely broken span', () => {
    const text = [
      'Peak density $\\lambda_0$ and a broken bit $\\frac{x}{$ here.',
      '',
      'Total charge: $$Q = \\int_{-\\infty}^{\\infty} \\lambda_0 e^{-\\frac{x^2}{2\\sigma^2}} dx$$',
    ].join('\n')
    const { invalid, cleaned } = validateMath(text)
    // The valid display integral survives; the structurally-broken span is caught.
    expect(cleaned).toContain('$$Q = \\int_{-\\infty}^{\\infty}')
    expect(invalid.some((s) => s.raw.includes('\\frac{x}{'))).toBe(true)
  })
})
