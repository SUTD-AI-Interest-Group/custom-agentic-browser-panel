import { describe, expect, it, vi } from 'vitest'
import { handleAppMessage, type AppBridgeHost } from './appBridge'

function host(overrides: Partial<AppBridgeHost> = {}): AppBridgeHost {
  return {
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    readResource: vi.fn().mockResolvedValue({ contents: [{ uri: 'ui://x', text: '<p/>' }] }),
    openLink: vi.fn(),
    onSizeChange: vi.fn(),
    onUserMessage: vi.fn(),
    context: () => ({
      theme: 'light',
      toolName: 'generate_image',
      toolInput: { q: 1 },
      toolResult: { content: [{ type: 'text', text: 'done' }], structuredContent: { a: 2 } },
    }),
    ...overrides,
  }
}

const req = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, params })

describe('handleAppMessage', () => {
  it('answers ui/initialize with the spec handshake result', async () => {
    const out = await handleAppMessage(
      req(1, 'ui/initialize', { protocolVersion: '2026-01-26', clientInfo: { name: 'app', version: '1' } }),
      host(),
    )
    expect(out).toHaveLength(1)
    const r = out[0] as { id: number; result: Record<string, any> }
    expect(r.id).toBe(1)
    expect(r.result.protocolVersion).toBe('2026-01-26')
    expect(typeof r.result.hostInfo.name).toBe('string')
    expect(typeof r.result.hostInfo.version).toBe('string')
    expect(r.result.hostCapabilities).toMatchObject({ openLinks: {}, serverTools: {} })
    expect(r.result.hostContext.theme).toBe('light')
    expect(r.result.hostContext.displayMode).toBe('inline')
    expect(r.result.hostContext.platform).toBe('web')
    expect(r.result.hostContext.toolInfo.tool.name).toBe('generate_image')
  })

  it('delivers tool-input and tool-result after ui/notifications/initialized', async () => {
    const out = await handleAppMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, host())
    expect(out.map((m: any) => m.method)).toEqual([
      'ui/notifications/tool-input',
      'ui/notifications/tool-result',
    ])
    const [input, result] = out as any[]
    expect(input.params.arguments).toEqual({ q: 1 })
    expect(result.params.structuredContent).toEqual({ a: 2 })
    expect(result.params.content).toEqual([{ type: 'text', text: 'done' }])
  })

  it('routes tools/call through the host and envelopes the raw result', async () => {
    const h = host()
    const out = await handleAppMessage(req(2, 'tools/call', { name: 'job_status', arguments: { id: 'j1' } }), h)
    expect(h.callTool).toHaveBeenCalledWith('job_status', { id: 'j1' })
    expect(out[0]).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'ok' }] } })
  })

  it('envelopes a thrown/denied tool call as a JSON-RPC error', async () => {
    const h = host({ callTool: vi.fn().mockRejectedValue(new Error('The user denied this call.')) })
    const out = await handleAppMessage(req(3, 'tools/call', { name: 't' }), h)
    expect(out[0]).toMatchObject({ id: 3, error: { code: -32000, message: 'The user denied this call.' } })
  })

  it('routes resources/read through the host', async () => {
    const h = host()
    const out = await handleAppMessage(req(4, 'resources/read', { uri: 'ui://srv/x' }), h)
    expect(h.readResource).toHaveBeenCalledWith('ui://srv/x')
    expect(out[0]).toMatchObject({ id: 4, result: { contents: [{ uri: 'ui://x', text: '<p/>' }] } })
  })

  it('handles ui/notifications/size-changed with width+height', async () => {
    const h = host()
    const out = await handleAppMessage(
      { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: 400, height: 620 } },
      h,
    )
    expect(h.onSizeChange).toHaveBeenCalledWith(400, 620)
    expect(out).toEqual([])
  })

  it('routes ui/open-link and answers', async () => {
    const h = host()
    const out = await handleAppMessage(req(5, 'ui/open-link', { url: 'https://example.com' }), h)
    expect(h.openLink).toHaveBeenCalledWith('https://example.com')
    expect(out[0]).toEqual({ jsonrpc: '2.0', id: 5, result: {} })
  })

  it('refuses a non-http(s) link', async () => {
    const h = host()
    const out = await handleAppMessage(req(6, 'ui/open-link', { url: 'javascript:alert(1)' }), h)
    expect(h.openLink).not.toHaveBeenCalled()
    expect(out[0]).toMatchObject({ error: { code: -32602 } })
  })

  it('forwards ui/message text to the host and acknowledges', async () => {
    const h = host()
    const out = await handleAppMessage(
      req(7, 'ui/message', { role: 'user', content: { type: 'text', text: 'from the app' } }),
      h,
    )
    expect(h.onUserMessage).toHaveBeenCalledWith('from the app')
    expect(out[0]).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
  })

  it('grants only inline display mode', async () => {
    const out = await handleAppMessage(req(8, 'ui/request-display-mode', { mode: 'fullscreen' }), host())
    expect(out[0]).toEqual({ jsonrpc: '2.0', id: 8, result: { mode: 'inline' } })
  })

  it('answers ping', async () => {
    const out = await handleAppMessage(req(9, 'ping'), host())
    expect(out[0]).toEqual({ jsonrpc: '2.0', id: 9, result: {} })
  })

  it('accepts ui/update-model-context without failing', async () => {
    const out = await handleAppMessage(
      req(10, 'ui/update-model-context', { structuredContent: { done: true } }),
      host(),
    )
    expect(out[0]).toEqual({ jsonrpc: '2.0', id: 10, result: {} })
  })

  it('ignores app log notifications silently', async () => {
    const out = await handleAppMessage(
      { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', text: 'dbg' } },
      host(),
    )
    expect(out).toEqual([])
  })

  it('answers an unknown request with method-not-found and ignores unknown notifications', async () => {
    const out = await handleAppMessage(req(11, 'fs/read'), host())
    expect(out[0]).toMatchObject({ id: 11, error: { code: -32601 } })
    expect(await handleAppMessage({ jsonrpc: '2.0', method: 'weird/thing' }, host())).toEqual([])
  })

  it('ignores malformed messages entirely', async () => {
    expect(await handleAppMessage(null, host())).toEqual([])
    expect(await handleAppMessage('hi', host())).toEqual([])
    expect(await handleAppMessage({ jsonrpc: '1.0', id: 1, method: 'x' }, host())).toEqual([])
    expect(await handleAppMessage({ jsonrpc: '2.0' }, host())).toEqual([])
  })
})
