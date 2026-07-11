import { describe, it, expect } from 'vitest'
import {
  ALWAYS_ON,
  META_NAMES,
  buildCatalog,
  searchCatalog,
  partitionToolNames,
  resolveActiveTools,
  type CatalogEntry,
} from './toolDiscovery'

const TOOLS = {
  ToolSearch: { description: 'list tools' },
  GetTool: { description: 'load tools' },
  ReadPage: { description: 'Read the current tab' },
  ReadTabs: { description: 'List or read other open tabs' },
  QueryBrowserData: { description: 'history bookmarks top sites downloads' },
}

describe('buildCatalog', () => {
  it('lists real tools with descriptions and excludes meta-tools', () => {
    const cat = buildCatalog(TOOLS)
    const names = cat.map((e) => e.name)
    expect(names).toContain('ReadPage')
    expect(names).toContain('QueryBrowserData')
    expect(names).not.toContain('ToolSearch')
    expect(names).not.toContain('GetTool')
    expect(cat.find((e) => e.name === 'ReadPage')?.description).toBe('Read the current tab')
  })
  it('tolerates a missing description', () => {
    expect(buildCatalog({ Foo: {} })).toEqual([{ name: 'Foo', description: '' }])
  })
})

describe('searchCatalog', () => {
  const cat: CatalogEntry[] = buildCatalog(TOOLS)
  it('returns everything for an empty/omitted query', () => {
    expect(searchCatalog(cat)).toEqual(cat)
    expect(searchCatalog(cat, '   ')).toEqual(cat)
  })
  it('matches case-insensitively on name and description', () => {
    expect(searchCatalog(cat, 'READ').map((e) => e.name)).toEqual(['ReadPage', 'ReadTabs'])
    expect(searchCatalog(cat, 'bookmarks').map((e) => e.name)).toEqual(['QueryBrowserData'])
  })
  it('returns [] when nothing matches', () => {
    expect(searchCatalog(cat, 'zzz')).toEqual([])
  })
})

describe('partitionToolNames', () => {
  const cat = buildCatalog(TOOLS)
  it('splits known from unknown names', () => {
    expect(partitionToolNames(['ReadPage', 'Nope', 'ReadTabs'], cat)).toEqual({
      valid: ['ReadPage', 'ReadTabs'],
      unknown: ['Nope'],
    })
  })
})

describe('resolveActiveTools', () => {
  it('always includes the always-on core and dedupes', () => {
    const out = resolveActiveTools(new Set(['ReadPage', 'NavigateTab']))
    expect(out).toEqual(expect.arrayContaining([...ALWAYS_ON, 'NavigateTab']))
    expect(out.filter((n) => n === 'ReadPage')).toHaveLength(1)
  })
  it('intersects with existing tool names when provided', () => {
    const out = resolveActiveTools(new Set(['SearchMemory', 'Ghost']), ['ReadPage', 'ToolSearch', 'GetTool', 'SearchMemory'])
    expect(out).toContain('SearchMemory')
    expect(out).not.toContain('Ghost')
    expect(out).not.toContain('ReadTabs')
  })
})

describe('constants', () => {
  it('meta names are the two disclosure tools', () => {
    expect([...META_NAMES].sort()).toEqual(['GetTool', 'ToolSearch'])
    expect(ALWAYS_ON).toContain('ReadPage')
  })
})
