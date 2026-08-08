import { describe, it, expect } from 'vitest'
import { assembleSystemPrompt, splitSystemPrompt, type SystemPromptParts } from './systemPrompt'

const parts = (overrides: Partial<SystemPromptParts> = {}): SystemPromptParts => ({
  systemPrompt: 'BASE',
  toolDisclosureNote: '\n\nDISCLOSURE',
  accessNote: '\n\nACCESS',
  browsingInsightsNote: '\n\nBROWSING',
  mathFormattingNote: '\n\nMATH',
  skillsCatalog: '\n\nSKILLS_CATALOG',
  memoryContext: 'MEMORY', // no leading \n\n of its own — see systemPrompt.ts
  activeSkills: '\n\nACTIVE_SKILL',
  retryNote: '\n\nRETRY',
  ...overrides,
})

describe('assembleSystemPrompt: ordering', () => {
  it('puts every stable part before every volatile part, in the documented order', () => {
    // A necessary PRECONDITION for splitSystemPrompt's cut to land in the
    // right place — not sufficient on its own for caching to work. See
    // splitSystemPrompt's tests below for the property that actually matters,
    // and src/agent/provider.test.ts for proof at the Anthropic wire level.
    const out = assembleSystemPrompt(parts())
    const order = [
      'BASE',
      'DISCLOSURE',
      'ACCESS',
      'BROWSING',
      'MATH',
      'SKILLS_CATALOG',
      'MEMORY',
      'ACTIVE_SKILL',
      'RETRY',
    ]
    let cursor = -1
    for (const marker of order) {
      const idx = out.indexOf(marker)
      expect(idx, `expected "${marker}" to appear, in order`).toBeGreaterThan(cursor)
      cursor = idx
    }
  })

  it('is a pure reorder: the same set of substrings appears regardless of which are set', () => {
    // Guards against the extraction accidentally dropping or duplicating a
    // part while moving it — every part's own text must still be present
    // exactly once.
    const out = assembleSystemPrompt(parts())
    for (const marker of ['BASE', 'DISCLOSURE', 'ACCESS', 'BROWSING', 'MATH', 'SKILLS_CATALOG', 'MEMORY', 'ACTIVE_SKILL', 'RETRY']) {
      expect(out.split(marker).length - 1).toBe(1)
    }
  })
})

describe('assembleSystemPrompt: empty parts', () => {
  it('adds no stray blank-line wrapper when memoryContext is empty', () => {
    const out = assembleSystemPrompt(parts({ memoryContext: '' }))
    expect(out).not.toContain('\n\n\n\n') // no doubled separator from the wrap-if-present logic
    expect(out.indexOf('SKILLS_CATALOG') < out.indexOf('ACTIVE_SKILL')).toBe(true)
  })

  it('produces just the base prompt when every optional part is empty', () => {
    const out = assembleSystemPrompt(
      parts({
        toolDisclosureNote: '',
        accessNote: '',
        browsingInsightsNote: '',
        mathFormattingNote: '',
        skillsCatalog: '',
        memoryContext: '',
        activeSkills: '',
        retryNote: '',
      }),
    )
    expect(out).toBe('BASE')
  })
})

// splitSystemPrompt: the property that actually matters. Anthropic's cache
// matches a marked block byte-for-byte with NO partial credit inside it, so
// a plain reorder into one string (assembleSystemPrompt) buys nothing on its
// own — see provider.ts's withCacheControl docstring and git history on this
// file for the earlier, incorrect version of this claim. What has to be true
// is that splitSystemPrompt's `stable` half is byte-identical whenever the
// volatile inputs change — that's what lets runAgentTurn tag `stable` alone
// as a cache breakpoint (via the providerOptions.lychee hint) and have it
// survive turn to turn. This file only proves the SPLIT's own output is
// correct; src/agent/provider.test.ts proves the wire actually reflects it
// (two Anthropic blocks, marker on the stable one only).
describe('splitSystemPrompt', () => {
  it('stable + volatile reconstitutes the same string assembleSystemPrompt produces', () => {
    const p = parts()
    const { stable, volatile } = splitSystemPrompt(p)
    expect(stable + volatile).toBe(assembleSystemPrompt(p))
  })

  it('stable contains only the stable parts; volatile contains only the volatile parts', () => {
    const { stable, volatile } = splitSystemPrompt(parts())
    for (const marker of ['BASE', 'DISCLOSURE', 'ACCESS', 'BROWSING', 'MATH', 'SKILLS_CATALOG']) {
      expect(stable).toContain(marker)
      expect(volatile).not.toContain(marker)
    }
    for (const marker of ['MEMORY', 'ACTIVE_SKILL', 'RETRY']) {
      expect(volatile).toContain(marker)
      expect(stable).not.toContain(marker)
    }
  })

  it('the property caching actually depends on: `stable` is byte-identical across two calls that differ ONLY in volatile content', () => {
    const a = splitSystemPrompt(parts({ memoryContext: 'MEMORY_TURN_1', retryNote: '' }))
    const b = splitSystemPrompt(
      parts({ memoryContext: 'MEMORY_TURN_2_COMPLETELY_DIFFERENT', activeSkills: '\n\nA_DIFFERENT_SKILL', retryNote: '\n\nRETRY_NOTE_B' }),
    )
    expect(a.stable).toBe(b.stable)
    expect(a.volatile).not.toBe(b.volatile) // sanity: the volatile halves actually differed
  })

  it('a change to a STABLE input (e.g. an installed/removed skill) DOES change `stable` — the cache genuinely misses when the stable content itself changes, as it should', () => {
    const a = splitSystemPrompt(parts())
    const b = splitSystemPrompt(parts({ skillsCatalog: '\n\nSKILLS_CATALOG_V2' }))
    expect(a.stable).not.toBe(b.stable)
  })

  it('volatile has no leading blank-line wrapper artifact when memoryContext is empty', () => {
    const { volatile } = splitSystemPrompt(parts({ memoryContext: '' }))
    expect(volatile.startsWith('\n\n\n\n')).toBe(false)
    expect(volatile).toBe('\n\nACTIVE_SKILL\n\nRETRY')
  })
})
