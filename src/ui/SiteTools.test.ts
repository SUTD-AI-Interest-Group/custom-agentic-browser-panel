import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import SiteTools from './SiteTools'
import type { SiteCatalog, WebMcpClient } from '../platform/webMcp'

function render(catalog: SiteCatalog, hidden = false) {
  const client = { snapshot: () => catalog, subscribe: () => () => {}, watch: vi.fn(), refresh: vi.fn() } as unknown as WebMcpClient
  return renderToStaticMarkup(createElement(SiteTools, { client, hidden }))
}
describe('site actions UI', () => {
  it('surfaces origin, tool names, approval and frame scope while escaping metadata', () => {
    const html = render({ status: 'ready', message: '', binding: { tabId: 1, documentId: 'doc', origin: 'https://site.test', url: 'https://site.test/', revision: 0, generation: 0 }, tools: [{ name: 'search', description: '<script>alert(1)</script>', inputSchema: {} }] })
    expect(html).toContain('1 available')
    expect(html).toContain('https://site.test')
    expect(html).toContain('search')
    expect(html).toContain('Each call needs your approval')
    expect(html).toContain('Embedded-frame actions are excluded')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })
  it('distinguishes unsupported runtime from a supported empty catalog', () => {
    expect(render({ status: 'unsupported', message: 'Native WebMCP is unavailable.', tools: [] })).toContain('Not supported')
    expect(render({ status: 'ready', message: '', tools: [] })).toContain('This page exposes no supported top-level WebMCP actions')
  })
  it('does not surface another page’s actions in a hidden chat', () => {
    expect(render({ status: 'ready', message: '', tools: [] }, true)).toBe('')
  })
})
