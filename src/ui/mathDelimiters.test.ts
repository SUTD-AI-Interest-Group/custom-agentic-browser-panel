import { describe, it, expect } from 'vitest'
import { normalizeMathDelimiters } from './mathDelimiters'

describe('normalizeMathDelimiters', () => {
  it('converts \\(...\\) to $...$', () => {
    expect(normalizeMathDelimiters('The value \\(x^2\\) is positive.')).toBe(
      'The value $x^2$ is positive.',
    )
  })

  it('converts \\[...\\] to a blank-line-isolated $$...$$ block', () => {
    expect(normalizeMathDelimiters('Result: \\[E = mc^2\\]')).toBe('Result: \n\n$$\nE = mc^2\n$$\n\n')
  })

  it('handles two separate \\(...\\) spans in the same text', () => {
    expect(normalizeMathDelimiters('The value \\(x\\) equals \\(y\\).')).toBe(
      'The value $x$ equals $y$.',
    )
  })

  it('leaves literal $$...$$ untouched (avoids currency false-positives)', () => {
    const text = 'It costs $$5$$ today'
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it('never rewrites \\( / \\[ inside a fenced code block', () => {
    const text = '```\nsome \\(shell escape\\) example\n```\ntail'
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it('never rewrites \\( / \\[ inside an unterminated fence (mid-stream)', () => {
    const text = '```\nsome \\(shell escape\\) example'
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it('never rewrites \\( / \\[ inside an inline code span', () => {
    const text = 'run `\\(literally\\)` here'
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it('leaves unmatched \\( alone when no closing \\) exists anywhere', () => {
    const text = 'discussing shell escaping \\( with no close'
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  // F5 (d12): the lazy `[\s\S]+?` body did not exclude the opening delimiter's
  // own characters, so a long run of unmatched `\(` forced O(remaining-length)
  // backtracking at each of O(n) starting positions — O(n^2) overall. This is
  // a ratio-based (machine-independent) regression test: a linear
  // implementation's time roughly doubles when input doubles; the original
  // implementation's time roughly quadrupled per doubling (measured ~4x by the
  // audit). Asserting comfortably under that (2.5x) fails on the old code and
  // passes on a linear one.
  it('stays roughly linear on adversarial unmatched \\( runs (F5, no quadratic blowup)', () => {
    const adversarial = (n: number) => '\\(a'.repeat(n)

    const time = (n: number): number => {
      const text = adversarial(n)
      const start = performance.now()
      normalizeMathDelimiters(text)
      return performance.now() - start
    }

    // Warm up (JIT) before measuring.
    time(2000)

    const n = 8000
    const tN = time(n)
    const t2N = time(n * 2)

    // Guard against a near-zero baseline making the ratio noisy.
    expect(tN).toBeGreaterThan(0)
    expect(t2N).toBeLessThan(Math.max(tN * 2.5, 20))
  })

  it('stays roughly linear on adversarial unmatched \\[ runs (F5, no quadratic blowup)', () => {
    const adversarial = (n: number) => '\\[a'.repeat(n)

    const time = (n: number): number => {
      const text = adversarial(n)
      const start = performance.now()
      normalizeMathDelimiters(text)
      return performance.now() - start
    }

    time(2000)

    const n = 8000
    const tN = time(n)
    const t2N = time(n * 2)

    expect(tN).toBeGreaterThan(0)
    expect(t2N).toBeLessThan(Math.max(tN * 2.5, 20))
  })

  it('does not throw on every prefix of an adversarial unmatched-delimiter run', () => {
    const text = '\\(a'.repeat(500) + '\\[b'.repeat(500)
    for (let i = 0; i <= text.length; i += 37) {
      expect(() => normalizeMathDelimiters(text.slice(0, i))).not.toThrow()
    }
  })
})
