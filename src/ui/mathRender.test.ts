import { describe, it, expect } from 'vitest'
import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import { normalizeMathDelimiters } from './mathDelimiters'
import { validateMath } from './mathValidate'

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
})
