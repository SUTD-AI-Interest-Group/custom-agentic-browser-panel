import { beforeEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import McpUpdates from './McpUpdates'
const state = vi.hoisted(() => ({ runtime: [] as unknown[] }))
vi.mock('../../mcp/manager', () => ({ getMcpManager: () => ({ runtime: () => state.runtime }) }))
beforeEach(() => { state.runtime = [{ name: 'server', status: 'connected', protocol: '2026-07-28', updateScope: 'new-account', resources: [{ uri: 'file:///safe', name: '<script>evil</script>' }] }] })
it('does not show prior-account URI selections as active consent', () => {
  const html = renderToStaticMarkup(createElement(McpUpdates, { name: 'server', value: { enabled: true, scope: 'old-account', resourceUris: ['file:///private-account-secret'] }, onChange: vi.fn() }))
  expect(html).not.toContain('checked=""')
  expect(html).not.toContain('private-account-secret')
})
it('escapes server supplied resource labels and shows the foreground-only boundary', () => {
  const html = renderToStaticMarkup(createElement(McpUpdates, { name: 'server', value: { enabled: true, scope: 'new-account', resourceUris: [] }, onChange: vi.fn() }))
  expect(html).toContain('&lt;script&gt;evil&lt;/script&gt;')
  expect(html).toContain('while the side panel is open')
  expect(html).not.toContain('<script>')
})
it('disables opt-in for legacy MCP without pretending it supports modern subscriptions', () => {
  state.runtime = [{ name: 'server', status: 'connected', protocol: 'legacy' }]
  const html = renderToStaticMarkup(createElement(McpUpdates, { name: 'server', onChange: vi.fn() }))
  expect(html).toContain('legacy MCP')
  expect(html).toContain('disabled=""')
})
