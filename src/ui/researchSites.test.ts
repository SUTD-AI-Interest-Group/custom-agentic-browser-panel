import { expect, test } from 'vitest'
import { addSite } from './researchSites'

test('normalizes and adds a bare host', () => {
  expect(addSite([], 'WWW.Example.com')).toEqual(['example.com'])
})

test('returns the same array reference for junk input', () => {
  const sites = ['example.com']
  expect(addSite(sites, '   ')).toBe(sites)
})

test('drops a dotless entry — a bare public suffix would restrict nothing', () => {
  const sites: string[] = []
  expect(addSite(sites, 'com')).toBe(sites)
})

test('does not add a plain duplicate', () => {
  const sites = ['example.com']
  expect(addSite(sites, 'example.com')).toBe(sites)
})

test('dedupes against a differently-formatted duplicate (scheme, www, path)', () => {
  const sites = ['example.com']
  expect(addSite(sites, 'https://www.example.com/some/path')).toBe(sites)
})

test('appends without disturbing existing entries', () => {
  const sites = ['example.com']
  expect(addSite(sites, 'other.org')).toEqual(['example.com', 'other.org'])
})
