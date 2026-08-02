import { describe, it, expect } from 'vitest'
import { validateMath } from './mathValidate'

describe('validateMath', () => {
  it('keeps balanced inline and display math (inline verbatim, display preserved)', () => {
    const text = 'Peak at $x=0$ and\n\n$$Q = \\lambda_0 \\sigma \\sqrt{2\\pi}$$\n\ndone'
    const { cleaned, invalid } = validateMath(text)
    expect(invalid).toHaveLength(0)
    expect(cleaned).toContain('$x=0$') // inline math untouched
    expect(cleaned).toContain('$$Q = \\lambda_0 \\sigma \\sqrt{2\\pi}$$') // display preserved
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

  it('records offsets that slice the original text back to raw', () => {
    const text = 'a $x=1$ then $\\frac{a}{$ tail'
    const { invalid } = validateMath(text)
    expect(invalid).toHaveLength(1)
    expect(text.slice(invalid[0].start, invalid[0].end)).toBe(invalid[0].raw)
  })

  it('neutralizes a structurally-invalid display block and flags display: true', () => {
    const { cleaned, invalid } = validateMath('$$\\frac{a}{$$')
    expect(invalid).toHaveLength(1)
    expect(invalid[0].display).toBe(true)
    expect(invalid[0].raw).toBe('$$\\frac{a}{$$')
    expect(cleaned).toBe('`$$\\frac{a}{$$`')
  })

  it('blank-line-isolates a valid display block glued to the previous line', () => {
    // A $$…$$ that starts a line not separated from prose by a blank line is
    // folded into the paragraph and never tokenized by marked-katex. Ensuring a
    // blank line before (and after) it makes marked's block rule fire.
    const { cleaned, invalid } = validateMath('it would be:\n$$E = mc^2$$')
    expect(invalid).toHaveLength(0)
    expect(cleaned).toContain('\n\n$$E = mc^2$$')
  })

  it('does not flag two $ amounts straddling a Windows path as broken math (F3)', () => {
    // marked-katex-extension's own inline tokenizer requires whitespace/
    // sentence-punctuation/EOS immediately after a closing $ — otherwise it
    // never tokenizes the pairing as math in the first place. validateMath must
    // apply the same requirement, or it neutralizes ordinary prose (and, via
    // repairAssistantMath, can silently trigger an LLM "fix" for text that was
    // never broken math at all).
    const text = 'It costs $50 to license, stored at C:\\Users\\name\\config, with a $75 upgrade.'
    const { invalid, cleaned } = validateMath(text)
    expect(invalid).toHaveLength(0)
    expect(cleaned).not.toContain('<code>')
    expect(cleaned).not.toContain('`')
  })

  it('does not flag two adjacent currency amounts as broken math', () => {
    // The audit brief's literal example: marked-katex-extension's own tokenizer
    // never pairs these ($10 is immediately followed by a letter, not
    // whitespace/punctuation/EOS), so validateMath must agree and never
    // neutralize this as a broken span (whether it leaves the $ signs alone or
    // escapes them is an implementation detail — either renders as plain text).
    const { invalid, cleaned } = validateMath('It costs $5 and $10 depending on size.')
    expect(invalid).toHaveLength(0)
    expect(cleaned).not.toContain('<code>')
    expect(cleaned).not.toContain('`')
  })

  it('still flags genuinely broken math whose closing $ is followed by punctuation/space', () => {
    // The lookahead must only suppress pairings marked-katex-extension itself
    // would never tokenize — a real, intentional (if broken) math span
    // followed by a space/period must still be caught.
    const { invalid } = validateMath('width $\\frac{a}{$ end.')
    expect(invalid).toHaveLength(1)
    expect(invalid[0].raw).toBe('$\\frac{a}{$')
  })
})
