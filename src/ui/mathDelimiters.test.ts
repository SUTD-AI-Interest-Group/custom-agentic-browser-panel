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
  // implementation's time roughly quadruples when input quadruples; the
  // original O(n^2) implementation's time roughly grew ~16x for the same 4x
  // input growth (quadratic; measured ~4x per DOUBLING by the audit, so ~16x
  // per quadrupling — reconfirmed directly while writing this version: 16.7x
  // on this machine). 8 is the geometric midpoint of 4 and 16, so it passes a
  // linear implementation and fails a quadratic one with equal (2x, in
  // log-space) margin on both sides.
  //
  // Each sample is the MINIMUM over several repetitions, not one reading — a
  // single `performance.now()` sample can be inflated by a GC pause or a
  // scheduler preemption stealing the CPU mid-measurement (exactly what
  // happened under full-suite parallel contention: this test occasionally
  // timed out even though the algorithm itself hadn't regressed). Contention
  // can only ever ADD delay to a given run, never subtract it, so the
  // minimum across repeats is a stable estimate of the algorithm's true cost
  // that a single unlucky tick can't distort — this is what actually removes
  // the flakiness, not just a wider ratio threshold on its own.
  const MIN_OF_REPS = 7

  function timeMinMs(fn: (text: string) => unknown, text: string): number {
    let best = Infinity
    for (let i = 0; i < MIN_OF_REPS; i++) {
      const start = performance.now()
      fn(text)
      const dt = performance.now() - start
      if (dt < best) best = dt
    }
    return best
  }

  it('stays roughly linear on adversarial unmatched \\( runs (F5, no quadratic blowup)', () => {
    const adversarial = (n: number) => '\\(a'.repeat(n)
    const time = (n: number) => timeMinMs(normalizeMathDelimiters, adversarial(n))

    time(2000) // warm up (JIT) before measuring

    const n = 8000
    const tN = time(n)
    const t4N = time(n * 4)

    // Guard against a near-zero baseline making the ratio noisy.
    expect(tN).toBeGreaterThan(0)
    expect(t4N).toBeLessThan(Math.max(tN * 8, 20))
  })

  it('stays roughly linear on adversarial unmatched \\[ runs (F5, no quadratic blowup)', () => {
    const adversarial = (n: number) => '\\[a'.repeat(n)
    const time = (n: number) => timeMinMs(normalizeMathDelimiters, adversarial(n))

    time(2000)

    const n = 8000
    const tN = time(n)
    const t4N = time(n * 4)

    expect(tN).toBeGreaterThan(0)
    expect(t4N).toBeLessThan(Math.max(tN * 8, 20))
  })

  it('does not throw on every prefix of an adversarial unmatched-delimiter run', () => {
    const text = '\\(a'.repeat(500) + '\\[b'.repeat(500)
    for (let i = 0; i <= text.length; i += 37) {
      expect(() => normalizeMathDelimiters(text.slice(0, i))).not.toThrow()
    }
  })
})
