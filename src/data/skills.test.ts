import { describe, expect, it } from 'vitest'
import { accentColor, parseSkillMarkdown, serializeSkill, validateSkill, validateSkillName, type Skill } from './skills'

// Pure logic only — listSkills/saveSkill/etc. are IndexedDB-coupled; this file
// had zero test coverage before this pass despite being fully pure and already
// shaped for it (flagged by d13).

describe('validateSkillName', () => {
  it('requires a name', () => {
    expect(validateSkillName('')).toMatch(/required/i)
  })

  it('rejects a name over 64 characters', () => {
    expect(validateSkillName('a'.repeat(65))).toMatch(/64/)
  })

  it('accepts lowercase alphanumeric segments joined by single hyphens', () => {
    expect(validateSkillName('summarizing-pages')).toBeNull()
    expect(validateSkillName('a1-b2-c3')).toBeNull()
  })

  it('rejects uppercase, spaces, leading/trailing/consecutive hyphens', () => {
    expect(validateSkillName('Summarizing')).not.toBeNull()
    expect(validateSkillName('summarizing pages')).not.toBeNull()
    expect(validateSkillName('-leading')).not.toBeNull()
    expect(validateSkillName('trailing-')).not.toBeNull()
    expect(validateSkillName('double--hyphen')).not.toBeNull()
  })

  it('rejects reserved words anywhere in the name', () => {
    expect(validateSkillName('using-claude')).toMatch(/claude/)
    expect(validateSkillName('anthropic-helper')).toMatch(/anthropic/)
  })
})

describe('validateSkill', () => {
  const valid = { name: 'summarizing-pages', description: 'Summarizes the page.', body: 'Do the thing.' }

  it('accepts a well-formed skill', () => {
    expect(validateSkill(valid)).toBeNull()
  })

  it('rejects an invalid name (delegates to validateSkillName)', () => {
    expect(validateSkill({ ...valid, name: 'Bad Name' })).not.toBeNull()
  })

  it('requires a non-blank description', () => {
    expect(validateSkill({ ...valid, description: '   ' })).toMatch(/[Dd]escription/)
  })

  it('rejects a description over 1024 characters', () => {
    expect(validateSkill({ ...valid, description: 'x'.repeat(1025) })).toMatch(/1024/)
  })

  it('rejects a multi-line description', () => {
    expect(validateSkill({ ...valid, description: 'line one\nline two' })).toMatch(/single line/i)
  })

  it('requires a non-blank body', () => {
    expect(validateSkill({ ...valid, body: '   ' })).toMatch(/[Ii]nstructions/)
  })
})

function sampleSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'id-1',
    name: 'summarizing-pages',
    description: 'Summarizes the page the user is viewing.',
    body: 'Read the page, then write a tight summary.',
    source: 'builtin',
    userInvocable: true,
    modelInvocable: true,
    enabled: true,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  }
}

describe('serializeSkill / parseSkillMarkdown round trip', () => {
  it('round-trips name, description, body and both invocable flags', () => {
    const md = serializeSkill(sampleSkill())
    const parsed = parseSkillMarkdown(md)
    expect(parsed.name).toBe('summarizing-pages')
    expect(parsed.description).toBe('Summarizes the page the user is viewing.')
    expect(parsed.body).toBe('Read the page, then write a tight summary.')
    expect(parsed.userInvocable).toBe(true)
    expect(parsed.modelInvocable).toBe(true)
  })

  it('round-trips false invocable flags (not just the truthy default)', () => {
    const md = serializeSkill(sampleSkill({ userInvocable: false, modelInvocable: false }))
    const parsed = parseSkillMarkdown(md)
    expect(parsed.userInvocable).toBe(false)
    expect(parsed.modelInvocable).toBe(false)
  })

  it('round-trips an optional icon and color when present', () => {
    const md = serializeSkill(sampleSkill({ icon: '📰', color: '#abcdef' }))
    const parsed = parseSkillMarkdown(md)
    expect(parsed.icon).toBe('📰')
    expect(parsed.color).toBe('#abcdef')
  })

  it('omits icon/color from the frontmatter when unset', () => {
    const md = serializeSkill(sampleSkill())
    expect(md).not.toMatch(/icon:/)
    expect(md).not.toMatch(/color:/)
  })

  it('falls back to treating the whole input as the body when there is no frontmatter', () => {
    const parsed = parseSkillMarkdown('Just some instructions, no frontmatter.')
    expect(parsed.name).toBe('')
    expect(parsed.body).toBe('Just some instructions, no frontmatter.')
    // Defaults lean permissive when nothing overrides them.
    expect(parsed.userInvocable).toBe(true)
    expect(parsed.modelInvocable).toBe(true)
  })
})

describe('accentColor', () => {
  it('returns the explicit color when set', () => {
    expect(accentColor({ name: 'anything', color: '#123456' })).toBe('#123456')
  })

  it('is deterministic for the same name', () => {
    const a = accentColor({ name: 'summarizing-pages' })
    const b = accentColor({ name: 'summarizing-pages' })
    expect(a).toBe(b)
  })

  it('returns a valid hsl() string derived from the name', () => {
    expect(accentColor({ name: 'x' })).toMatch(/^hsl\(\d+(\.\d+)? 62% 55%\)$/)
  })
})
