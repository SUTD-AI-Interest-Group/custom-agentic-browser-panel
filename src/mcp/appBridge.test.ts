import { describe, expect, it, vi } from 'vitest'
import { handleAppMessage, type AppBridgeHost } from './appBridge'

function host(overrides: Partial<AppBridgeHost> = {}): AppBridgeHost {
  return {
    callTool: vi.fn().mockResolvedValue({ ok: true }),
    openLink: vi.fn(),
    onSizeChange: vi.fn(),
    getContext: () => ({ theme: 'light', toolInput: { q: 1 }, toolOutput: { a: 2 } }),
    ...overrides,
  }
}

describe('handleAppMessage', () => {
  it('answers ui/initialize with the host context', async () => {
    const r = await handleAppMessage({ jsonrpc: '2.0', id: 1, method: 'ui/initialize' }, host())
    expect(r).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { context: { theme: 'light', toolInput: { q: 1 }, toolOutput: { a: 2 } } },
    })
  })

  it('routes tools/call through the host and envelopes the result', async () => {
    const h = host()
    const r = await handleAppMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'refresh', arguments: { x: 1 } } },
      h,
    )
    expect(h.callTool).toHaveBeenCalledWith('refresh', { x: 1 })
    expect(r).toEqual({ jsonrpc: '2.0', id: 2, result: { ok: true } })
  })

  it('envelopes a thrown tool call as a JSON-RPC error', async () => {
    const h = host({ callTool: vi.fn().mockRejectedValue(new Error('denied')) })
    const r = await handleAppMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 't' } },
      h,
    )
    expect(r).toMatchObject({ jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'denied' } })
  })

  it('handles the ui/size-changed notification without a response', async () => {
    const h = host()
    const r = await handleAppMessage(
      { jsonrpc: '2.0', method: 'ui/size-changed', params: { height: 420 } },
      h,
    )
    expect(h.onSizeChange).toHaveBeenCalledWith(420)
    expect(r).toBeNull()
  })

  it('routes ui/open-link and answers', async () => {
    const h = host()
    const r = await handleAppMessage(
      { jsonrpc: '2.0', id: 4, method: 'ui/open-link', params: { url: 'https://example.com' } },
      h,
    )
    expect(h.openLink).toHaveBeenCalledWith('https://example.com')
    expect(r).toEqual({ jsonrpc: '2.0', id: 4, result: {} })
  })

  it('refuses a non-http(s) link', async () => {
    const h = host()
    const r = await handleAppMessage(
      { jsonrpc: '2.0', id: 5, method: 'ui/open-link', params: { url: 'javascript:alert(1)' } },
      h,
    )
    expect(h.openLink).not.toHaveBeenCalled()
    expect(r).toMatchObject({ error: { code: -32602 } })
  })

  it('answers an unknown method with method-not-found', async () => {
    const r = await handleAppMessage({ jsonrpc: '2.0', id: 6, method: 'fs/read' }, host())
    expect(r).toMatchObject({ jsonrpc: '2.0', id: 6, error: { code: -32601 } })
  })

  it('ignores malformed messages entirely', async () => {
    expect(await handleAppMessage(null, host())).toBeNull()
    expect(await handleAppMessage('hi', host())).toBeNull()
    expect(await handleAppMessage({ jsonrpc: '1.0', id: 1, method: 'x' }, host())).toBeNull()
    expect(await handleAppMessage({ jsonrpc: '2.0' }, host())).toBeNull()
  })

  it('ignores an unknown notification (no id) silently', async () => {
    const r = await handleAppMessage({ jsonrpc: '2.0', method: 'weird/thing' }, host())
    expect(r).toBeNull()
  })
})
