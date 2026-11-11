import { describe, expect, it } from 'vitest'
import { boostCss, emptyBoost, siteOrigin, studioKey } from './studio'

describe('Studio site isolation and reversibility', () => {
  it('scopes to exact HTTP origin, including scheme and port', () => {
    expect(siteOrigin('https://example.com/path?q=private')).toBe(
      'https://example.com',
    )
    expect(studioKey(siteOrigin('http://localhost:3030/a')!)).not.toBe(
      studioKey('http://localhost:3031'),
    )
    for (const url of [
      'chrome://extensions',
      'file:///secret',
      'javascript:alert(1)',
      'bad url',
    ])
      expect(siteOrigin(url)).toBeNull()
  })
  it('disabling removes all styling, without losing saved edits', () => {
    const saved = {
      ...emptyBoost('https://example.com'),
      css: 'p { color:red }',
      font: 'Georgia',
      zaps: ['#advert'],
      palette: { hue: 120, saturation: 50, dark: true },
    }
    expect(boostCss(saved)).toContain('#advert { display: none !important; }')
    expect(boostCss(saved)).toContain('font-family: Georgia')
    expect(boostCss(saved)).toContain('color-scheme: dark')
    expect(boostCss({ ...saved, enabled: false })).toBe('')
    expect(boostCss({ ...saved, zaps: [] })).not.toContain('#advert')
    expect(boostCss(emptyBoost(saved.origin))).toBe('')
  })
})
