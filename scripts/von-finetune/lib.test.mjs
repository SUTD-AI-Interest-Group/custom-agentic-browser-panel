import { describe, expect, it } from 'vitest'
import { resolveSplits, siteKey, splitOf } from './lib.mjs'

describe('resolveSplits', () => {
  it('moves a val page to train when its site key is a train site in any corpus, never the reverse', () => {
    const pages = new Map([
      ['a', { pageId: 'a', site: 'ikea.com', split: 'train', corpus: 'teacher' }],
      ['b', { pageId: 'b', site: 'ikea', split: 'val', corpus: 'mind2web' }],
      ['c', { pageId: 'c', site: 'bbc.com', split: 'val', corpus: 'teacher' }],
      ['d', { pageId: 'd', site: 'bbc', split: 'train', corpus: 'mind2web' }],
      ['e', { pageId: 'e', site: 'united', split: 'val', corpus: 'mind2web' }],
    ])
    expect(resolveSplits(pages)).toBe(2)
    expect([...pages.values()].map((p) => p.split)).toEqual(['train', 'train', 'train', 'train', 'val'])
  })
  it('keys by first label', () => {
    expect(siteKey('www.ikea.com')).toBe('ikea')
    expect(siteKey('recreation.gov')).toBe('recreation')
  })
  it('keeps the teacher split deterministic per site', () => {
    expect(splitOf('https://www.ikea.com/us/en/')).toBe(splitOf('https://www.ikea.com/x'))
  })
})
