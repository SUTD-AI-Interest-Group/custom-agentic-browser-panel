import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// An undefined CSS custom property fails SILENTLY, which is why this needs a
// test rather than a convention.
//
// `color: var(--text-dim)` where `--text-dim` was never defined is invalid at
// computed-value time: the declaration does not fall back to the previous
// value, it resolves to `unset` — and `color` is inherited, so the element
// quietly renders in its parent's color instead. Two screenshot-card rules
// shipped like that for months (`.shot-card-dim`, `.shot-card-missing`, used
// across 7 call sites in 3 components), rendering secondary text at full
// strength with nothing anywhere to say so: no build error, no console warning,
// no failing test. Only reading the stylesheet found it.
//
// The rule this locks down is not "every token must be defined" — several uses
// are deliberately undefined-with-a-fallback, and `--pct` is set at runtime from
// ModelPicker's inline style. It is: **a var() use must either name a token
// defined in this file, or supply a fallback.** Both are safe; naming an
// undefined token with no fallback is the failure mode.
//
// Parses the real stylesheet (the sandboxCsp.test.ts technique) rather than
// asserting on a hand-maintained list, so it cannot drift from what ships.

const HERE = fileURLToPath(import.meta.url)
const STYLES_PATH = join(dirname(HERE), 'styles.css')

/**
 * The stylesheet with comments stripped.
 *
 * Load-bearing: a declaration's boundary check below looks for the `;` or `{`
 * that precedes it, and this file documents its tokens heavily — so
 * `--lychee` and `--lychee-limb`, which each follow an explanatory comment
 * rather than another declaration, were invisible to the parser until comments
 * were removed. That produced a false "defined only in dark mode" report on two
 * tokens that are defined in both.
 */
function css(): string {
  return readFileSync(STYLES_PATH, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Every `--token:` declaration in the file. */
function definedTokens(source: string): Set<string> {
  const out = new Set<string>()
  for (const m of source.matchAll(/(^|[;{}])\s*(--[a-zA-Z0-9-]+)\s*:/g)) out.add(m[2])
  return out
}

/** Every `var(--token …)` use, with whether it supplied a fallback. */
function tokenUses(source: string): Array<{ token: string; hasFallback: boolean }> {
  return [...source.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*([,)])/g)].map((m) => ({
    token: m[1],
    hasFallback: m[2] === ',',
  }))
}

describe('CSS custom properties', () => {
  it('never references an undefined token without a fallback', () => {
    const source = css()
    const defined = definedTokens(source)
    const unsafe = [
      ...new Set(
        tokenUses(source)
          .filter((u) => !u.hasFallback && !defined.has(u.token))
          .map((u) => u.token),
      ),
    ]
    // Named in the failure output so the fix is obvious from the message alone.
    expect(unsafe).toEqual([])
  })

  it('defines the core palette tokens the app leans on', () => {
    const defined = definedTokens(css())
    for (const token of ['--text', '--text-muted', '--accent', '--border', '--surface']) {
      expect(defined.has(token)).toBe(true)
    }
  })

  it('gives every dark-mode override a light-mode definition too', () => {
    // A token defined ONLY inside the dark block renders as unset in light mode
    // — the same silent failure as an undefined token, just harder to notice
    // because it works on the developer's machine.
    const source = css()
    const darkStart = source.indexOf('prefers-color-scheme: dark')
    expect(darkStart).toBeGreaterThan(-1)
    const light = definedTokens(source.slice(0, darkStart))
    const dark = definedTokens(source.slice(darkStart))
    const darkOnly = [...dark].filter((t) => !light.has(t))
    expect(darkOnly).toEqual([])
  })

  it('parses the tokens it claims to (guards the parser itself)', () => {
    // A regex that silently matched nothing would make every test above pass
    // vacuously — the exact way this class of guard rots.
    const defined = definedTokens(css())
    expect(defined.size).toBeGreaterThan(10)
    expect(tokenUses(css()).length).toBeGreaterThan(50)
  })
})
