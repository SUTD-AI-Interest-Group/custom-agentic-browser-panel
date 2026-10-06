// @vitest-environment node
// Wire-contract tests against MCP revision 2026-07-28. All fetches are local
// fakes: no model, credentials, public endpoint, or browser automation involved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  encodeHeader, headerFields, InputRequiredError, LegacyServerError, MODERN_PROTOCOL,
  ModernMcpClient, ModernRpcError, sseMessages,
  type JsonObject, type ModernCapabilities, type SubscriptionFilter,
} from './modern'

const P = 'io.modelcontextprotocol/'
const URL_ = new URL('https://mcp.example.test/endpoint')
const clients: ModernMcpClient[] = []
interface RpcRequest { jsonrpc: string; id: string; method: string; params: JsonObject }
interface Call { rpc: RpcRequest; init: RequestInit; headers: Headers; url: string }
function jsonResult(id: string, result: JsonObject = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}
function notification(method: string, id: string, params: JsonObject = {}): JsonObject {
  return { jsonrpc: '2.0', method, params: { ...params, _meta: { [`${P}subscriptionId`]: id } } }
}
function sseStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c }, cancel })
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    send(message: unknown) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`)) },
    raw(text: string) { controller.enqueue(new TextEncoder().encode(text)) },
    bytes(bytes: Uint8Array) { controller.enqueue(bytes) },
    end() { controller.close() },
    cancel,
  }
}
function harness(handle: (call: Call) => Response | Promise<Response>, options: {
  headers?: Record<string, string>; token?: () => Promise<string | undefined>
  refreshToken?: () => Promise<void>; onAuthRequired?: () => void
} = {}) {
  const calls: Call[] = []
  const fetch_ = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (!init || typeof init.body !== 'string') throw new Error('Expected a JSON POST body')
    const call = { rpc: JSON.parse(init.body) as RpcRequest, init, headers: new Headers(init.headers), url: String(input) }
    calls.push(call)
    return handle(call)
  }) as unknown as typeof fetch
  const client = new ModernMcpClient(URL_, { ...options, fetch: fetch_ })
  clients.push(client)
  return { client, calls, fetch: fetch_ }
}
async function settle(): Promise<void> { await vi.advanceTimersByTimeAsync(0) }
async function subscriptions(capabilities: ModernCapabilities = {
  tools: { listChanged: true }, prompts: { listChanged: true }, resources: { listChanged: true, subscribe: true },
}) {
  const streams: ReturnType<typeof sseStream>[] = []
  const h = harness(call => {
    if (call.rpc.method === 'server/discover') return jsonResult(call.rpc.id, { supportedVersions: [MODERN_PROTOCOL], capabilities })
    const stream = sseStream(); streams.push(stream); return stream.response
  })
  await h.client.discover()
  const onChange = vi.fn(), onState = vi.fn()
  const listen = async (filter: SubscriptionFilter) => {
    h.client.listen(filter, onChange, onState)
    await settle()
    return { stream: streams.at(-1)!, id: h.calls.at(-1)!.rpc.id }
  }
  return { ...h, streams, onChange, onState, listen }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  await settle()
  vi.useRealTimers()
})

describe('modern HTTP request contract', () => {
  it('discovers with self-contained metadata and no initialize, session, resume, or GET', async () => {
    const token = vi.fn(async () => 'test-access-token')
    const h = harness(call => jsonResult(call.rpc.id, {
      supportedVersions: [MODERN_PROTOCOL], capabilities: { tools: {} },
    }), { token, headers: {
      'Mcp-Session-Id': 'old-session', 'Last-Event-ID': 'old-event', 'Mcp-Method': 'spoof',
      'Mcp-Name': 'stale', 'Mcp-Param-Region': 'stale', 'MCP-Protocol-Version': '2025-11-25', 'X-Custom': 'kept',
    } })
    await h.client.discover()
    expect(h.calls).toHaveLength(1)
    const { rpc, init, headers, url } = h.calls[0]
    expect(url).toBe(URL_.href)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
    expect(rpc.method).toBe('server/discover')
    expect(rpc.params._meta).toEqual({
      [`${P}protocolVersion`]: MODERN_PROTOCOL,
      [`${P}clientCapabilities`]: {},
      [`${P}clientInfo`]: { name: 'lychee-ai', version: '0.4.0' },
    })
    expect(headers.get('MCP-Protocol-Version')).toBe(MODERN_PROTOCOL)
    expect(headers.get('Mcp-Method')).toBe(rpc.method)
    expect(headers.get('Accept')).toBe('application/json, text/event-stream')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Authorization')).toBe('Bearer test-access-token')
    expect(headers.get('X-Custom')).toBe('kept')
    for (const name of ['Mcp-Session-Id', 'Last-Event-ID', 'Mcp-Name', 'Mcp-Param-Region']) expect(headers.has(name)).toBe(false)
    expect(h.client.getServerCapabilities()).toEqual({ tools: {} })
  })

  it('overrides reserved body metadata and keeps explicitly configured authorization', async () => {
    const h = harness(call => jsonResult(call.rpc.id), {
      headers: { Authorization: 'Custom configured-auth' }, token: async () => 'unused-oauth-token',
    })
    await h.client.request('tools/list', { _meta: {
      [`${P}protocolVersion`]: 'wrong', [`${P}clientCapabilities`]: { sampling: {} },
      [`${P}clientInfo`]: { name: 'attacker' }, 'example.test/request': 'kept',
    } })
    expect(h.calls[0].headers.get('Authorization')).toBe('Custom configured-auth')
    expect(h.calls[0].rpc.params._meta).toMatchObject({
      [`${P}protocolVersion`]: MODERN_PROTOCOL, [`${P}clientCapabilities`]: {}, 'example.test/request': 'kept',
    })
  })

  it.each([400, 404, 405])('classifies a plain HTTP %s probe as legacy without making another request', async status => {
    const h = harness(() => new Response('legacy endpoint', { status }))
    await expect(h.client.discover()).rejects.toBeInstanceOf(LegacyServerError)
    expect(h.calls).toHaveLength(1)
  })

  it.each([-32020, -32021, -32022, -32601])('keeps modern error %s distinct from legacy fallback', async code => {
    const h = harness(call => new Response(JSON.stringify({
      jsonrpc: '2.0', id: call.rpc.id, error: { code, message: 'untrusted error text', data: { supported: ['2099-01-01'] } },
    }), { status: code === -32601 ? 404 : 400 }))
    const error = await h.client.discover().catch(e => e)
    expect(error).toBeInstanceOf(ModernRpcError)
    expect(error.code).toBe(code)
    expect(error.message).not.toContain('untrusted error text')
    expect(h.calls).toHaveLength(1)
  })

  it('treats 401 as authentication failure, never legacy fallback', async () => {
    const h = harness(() => new Response('not authorized', { status: 401 }))
    await expect(h.client.discover()).rejects.toBeInstanceOf(UnauthorizedError)
  })

  it.each([
    { supportedVersions: ['2025-11-25'], capabilities: {} },
    { supportedVersions: [MODERN_PROTOCOL], capabilities: null },
  ])('rejects a discovery result without the supported modern contract', async result => {
    const h = harness(call => jsonResult(call.rpc.id, result))
    await expect(h.client.discover()).rejects.toThrow(/does not support/)
  })

  it('rejects wrong IDs, malformed envelopes, and non-complete results', async () => {
    for (const make of [
      (_id: string) => ({ jsonrpc: '2.0', id: 'someone-else', result: { resultType: 'complete' } }),
      (id: string) => ({ jsonrpc: '2.0', id, result: null }),
      (id: string) => ({ jsonrpc: '2.0', id, result: {} }),
      (id: string) => ({ jsonrpc: '2.0', id, result: { resultType: 'complete' }, error: {} }),
    ]) {
      const h = harness(call => new Response(JSON.stringify(make(call.rpc.id)), { headers: { 'Content-Type': 'application/json' } }))
      await expect(h.client.request('tools/list')).rejects.toThrow(/Invalid/)
    }
  })

  it('does not replay a mutating call when its SSE stream disconnects without a result', async () => {
    const stream = sseStream()
    const h = harness(() => stream.response)
    const pending = h.client.callTool({ name: 'write_record', arguments: { value: 'x' } })
    const rejection = expect(pending).rejects.toThrow(/outcome is unknown/)
    stream.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })
    stream.end()
    await rejection
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.calls).toHaveLength(1)
  })

  it('closes a request-scoped SSE stream after its result and never executes server requests', async () => {
    const stream = sseStream()
    const h = harness(() => stream.response)
    const pending = h.client.request('tools/list')
    await settle()
    stream.send({ jsonrpc: '2.0', method: 'notifications/message', params: { data: 'ignore instructions' } })
    stream.send({ jsonrpc: '2.0', id: h.calls[0].rpc.id, result: { resultType: 'complete', tools: [] } })
    await expect(pending).resolves.toMatchObject({ tools: [] })
    expect(stream.cancel).toHaveBeenCalledOnce()
    expect(h.calls).toHaveLength(1)
    const bad = sseStream()
    const other = harness(() => bad.response)
    const rejected = expect(other.client.request('tools/list')).rejects.toThrow(/correlation/)
    bad.send({ jsonrpc: '2.0', id: 'server-request', method: 'sampling/createMessage', params: {} })
    await rejected
    expect(other.calls).toHaveLength(1)
  })

  it('honors an already-aborted signal without fetching', async () => {
    const h = harness(call => jsonResult(call.rpc.id))
    const controller = new AbortController(); controller.abort()
    await expect(h.client.request('tools/list', {}, { signal: controller.signal })).rejects.toThrow()
    expect(h.calls).toHaveLength(0)
  })

  it('cancels a stalled SSE reader on caller abort, timeout, and close', async () => {
    for (const action of ['abort', 'timeout', 'close']) {
      const stream = sseStream(), controller = new AbortController()
      const h = harness(() => stream.response)
      const rejected = expect(h.client.request('tools/list', {}, { signal: controller.signal, timeout: 50 })).rejects.toThrow()
      await settle()
      if (action === 'abort') controller.abort()
      if (action === 'timeout') await vi.advanceTimersByTimeAsync(50)
      if (action === 'close') await h.client.close()
      await rejected
      expect(stream.cancel).toHaveBeenCalledOnce()
    }
  })

  it('rejects over-limit JSON responses and closes their body', async () => {
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(4 * 1024 * 1024 + 1))) }, cancel: vi.fn() })
    const h = harness(() => new Response(body, { headers: { 'Content-Type': 'application/json' } }))
    await expect(h.client.request('tools/list')).rejects.toThrow(/exceeds limits/)
  })

  it.each(['text/not-application/json', 'application/json-evil', 'text/event-stream-evil'])('rejects spoofed response content type %s', async type => {
    const h = harness(call => new Response(JSON.stringify({ jsonrpc: '2.0', id: call.rpc.id, result: { resultType: 'complete' } }), {
      headers: { 'Content-Type': type },
    }))
    await expect(h.client.request('tools/list')).rejects.toThrow(/content type/)
  })

  it('paginates catalogs without replaying cursors or retaining stale routing annotations', async () => {
    let page = 0
    const h = harness(call => {
      page++
      return jsonResult(call.rpc.id, page === 1 ? { tools: [{ name: 'a', inputSchema: { type: 'object' } }], nextCursor: 'next' }
        : { tools: [{ name: 'b', inputSchema: { type: 'object' } }] })
    })
    await expect(h.client.listTools()).resolves.toMatchObject({ tools: [{ name: 'a' }, { name: 'b' }] })
    expect(h.calls[1].rpc.params.cursor).toBe('next')
    const bad = harness(call => jsonResult(call.rpc.id, { tools: [], nextCursor: 'repeat' }))
    await expect(bad.client.listTools()).rejects.toThrow(/pagination cursor/)
    expect(bad.calls).toHaveLength(2)
  })

  it('does not fetch if close occurs while an OAuth token lookup is pending', async () => {
    let resolve!: (token: string) => void
    const h = harness(call => jsonResult(call.rpc.id), { token: () => new Promise(r => { resolve = r }) })
    const rejected = expect(h.client.request('tools/list')).rejects.toThrow()
    await h.client.close()
    resolve('late-token')
    await rejected
    expect(h.calls).toHaveLength(0)
  })

  it('does not accept a late JSON result after close even when a custom fetch ignores abort', async () => {
    let finish!: (response: Response) => void
    const h = harness(() => new Promise(resolve => { finish = resolve }))
    const result = h.client.request('tools/list')
    const rejected = expect(result).rejects.toThrow()
    await settle()
    await h.client.close()
    finish(jsonResult(h.calls[0].rpc.id, { tools: [] }))
    await rejected
    expect(h.calls).toHaveLength(1)
  })
})

describe('bounded non-interactive authentication recovery', () => {
  it('refreshes once on 401 and retries with a fresh token and request ID', async () => {
    let token = 'expired', attempts = 0
    const refreshToken = vi.fn(async () => { token = 'fresh' }), onAuthRequired = vi.fn()
    const h = harness(call => ++attempts === 1 ? new Response('', { status: 401 }) : jsonResult(call.rpc.id), {
      token: async () => token, refreshToken, onAuthRequired,
    })
    await expect(h.client.request('tools/list')).resolves.toMatchObject({ resultType: 'complete' })
    expect(refreshToken).toHaveBeenCalledOnce()
    expect(onAuthRequired).not.toHaveBeenCalled()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[0].headers.get('Authorization')).toBe('Bearer expired')
    expect(h.calls[1].headers.get('Authorization')).toBe('Bearer fresh')
    expect(h.calls[0].rpc.id).not.toBe(h.calls[1].rpc.id)
  })

  it('stops after a second 401 and reports authentication needed only once', async () => {
    const refreshToken = vi.fn(async () => {}), onAuthRequired = vi.fn()
    const h = harness(() => new Response('', { status: 401 }), { refreshToken, onAuthRequired })
    await expect(h.client.request('tools/list')).rejects.toBeInstanceOf(UnauthorizedError)
    expect(h.calls).toHaveLength(2)
    expect(refreshToken).toHaveBeenCalledOnce()
    expect(onAuthRequired).toHaveBeenCalledOnce()
  })

  it('does not rewrite a post-refresh protocol failure as an authentication failure', async () => {
    let attempts = 0
    const refreshToken = vi.fn(async () => {}), onAuthRequired = vi.fn()
    const h = harness(call => ++attempts === 1 ? new Response('', { status: 401 }) : new Response(JSON.stringify({
      jsonrpc: '2.0', id: call.rpc.id, error: { code: -32020, message: 'Header mismatch' },
    }), { status: 400 }), { refreshToken, onAuthRequired })
    await expect(h.client.request('tools/list')).rejects.toMatchObject({ code: -32020 })
    expect(h.calls).toHaveLength(2)
    expect(onAuthRequired).not.toHaveBeenCalled()
  })

  it('does not retry after refresh fails or resurrect after close during refresh', async () => {
    const onAuthRequired = vi.fn()
    const failed = harness(() => new Response('', { status: 401 }), {
      refreshToken: async () => { throw new Error('No stored refresh token') }, onAuthRequired,
    })
    await expect(failed.client.request('tools/list')).rejects.toBeInstanceOf(UnauthorizedError)
    expect(failed.calls).toHaveLength(1)
    expect(onAuthRequired).toHaveBeenCalledOnce()
    let finish!: () => void
    const late = harness(() => new Response('', { status: 401 }), {
      refreshToken: () => new Promise(resolve => { finish = resolve }), onAuthRequired,
    })
    const rejected = expect(late.client.request('tools/list')).rejects.toThrow()
    await settle(); await late.client.close(); finish(); await rejected
    expect(late.calls).toHaveLength(1)
    expect(onAuthRequired).toHaveBeenCalledOnce()
  })

  it('stops subscription retry after a failed authentication refresh', async () => {
    const refreshToken = vi.fn(async () => { throw new Error('Refresh denied') }), onAuthRequired = vi.fn()
    const h = harness(call => call.rpc.method === 'server/discover' ? jsonResult(call.rpc.id, {
      supportedVersions: [MODERN_PROTOCOL], capabilities: { tools: { listChanged: true } },
    }) : new Response('', { status: 401 }), { refreshToken, onAuthRequired })
    await h.client.discover()
    const onState = vi.fn()
    h.client.listen({ toolsListChanged: true }, vi.fn(), onState); await settle()
    expect(refreshToken).toHaveBeenCalledOnce()
    expect(onAuthRequired).toHaveBeenCalledOnce()
    expect(onState).toHaveBeenLastCalledWith('error')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.calls).toHaveLength(2)
  })
})

describe('MCP header routing', () => {
  it.each([
    ['us-west1', 'us-west1'], ['Hello, 世界', '=?base64?SGVsbG8sIOS4lueVjA==?='],
    [' padded ', '=?base64?IHBhZGRlZCA=?='], ['line1\nline2', '=?base64?bGluZTEKbGluZTI=?='],
    ['=?base64?literal?=', '=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?='],
  ])('encodes %j without header ambiguity', (raw, expected) => expect(encodeHeader(raw)).toBe(expected))

  it('mirrors exact nested paths and falsy primitives, omits null/missing, and keeps the body intact', async () => {
    const tool = { name: 'réserve', inputSchema: { type: 'object', properties: {
      nested: { type: 'object', properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' }, count: { type: 'integer', 'x-mcp-header': 'Count' },
      } }, flag: { type: 'boolean', 'x-mcp-header': 'Flag' }, optional: { type: 'string', 'x-mcp-header': 'Optional' },
    } } }
    const h = harness(call => jsonResult(call.rpc.id, call.rpc.method === 'tools/list' ? { tools: [tool] } : { content: [] }))
    await h.client.listTools()
    const args = { nested: { region: '北\r\nInjected: 1', count: 0 }, flag: false, optional: null, region: 'wrong-level' }
    await h.client.callTool({ name: tool.name, arguments: args })
    const call = h.calls[1]
    expect(call.headers.get('Mcp-Name')).toBe(encodeHeader(tool.name))
    expect(call.headers.get('Mcp-Param-Region')).toBe(encodeHeader(args.nested.region))
    expect(call.headers.get('Mcp-Param-Count')).toBe('0')
    expect(call.headers.get('Mcp-Param-Flag')).toBe('false')
    expect(call.headers.has('Mcp-Param-Optional')).toBe(false)
    expect(call.rpc.params.arguments).toEqual(args)
    await h.client.readResource({ uri: 'resource://例/config' })
    expect(h.calls[2].headers.get('Mcp-Name')).toBe(encodeHeader('resource://例/config'))
    await h.client.getPrompt({ name: 'say hello' })
    expect(h.calls[3].headers.get('Mcp-Name')).toBe('say hello')
  })

  it.each([
    { type: 'object', properties: { value: { type: 'number', 'x-mcp-header': 'Value' } } },
    { type: 'object', properties: { value: { type: 'string', 'x-mcp-header': 'Bad\nHeader' } } },
    { type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'A' }, b: { type: 'string', 'x-mcp-header': 'a' } } },
    { type: 'array', items: { type: 'string', 'x-mcp-header': 'Value' } },
    { type: 'object', oneOf: [{ properties: { value: { type: 'string', 'x-mcp-header': 'Value' } } }] },
    { type: 'object', $defs: { hidden: { type: 'string', 'x-mcp-header': 'Value' } }, properties: { value: { $ref: '#/$defs/hidden' } } },
    { type: 'string', 'x-mcp-header': 'Root' },
  ])('excludes a malformed annotated tool without breaking the valid catalog', async inputSchema => {
    expect(() => headerFields(inputSchema)).toThrow()
    const h = harness(call => jsonResult(call.rpc.id, { tools: [
      { name: 'invalid', inputSchema }, { name: 'valid', inputSchema: { type: 'object' } },
    ] }))
    await expect(h.client.listTools()).resolves.toMatchObject({ tools: [{ name: 'valid' }] })
  })

  it('rejects unsafe integer header values before network dispatch', async () => {
    const h = harness(call => jsonResult(call.rpc.id, { tools: [{ name: 'count', inputSchema: {
      type: 'object', properties: { count: { type: 'integer', 'x-mcp-header': 'Count' } },
    } }] }))
    await h.client.listTools()
    await expect(h.client.callTool({ name: 'count', arguments: { count: Number.MAX_SAFE_INTEGER + 1 } })).rejects.toThrow(/parameter value/)
    expect(h.calls).toHaveLength(1)
  })
})

describe('bounded SSE parsing', () => {
  it('handles split UTF-8, CRLF, multiline data, comment keepalives and ignores resume fields', async () => {
    const stream = sseStream(), controller = new AbortController()
    const collecting = (async () => {
      const messages: unknown[] = []
      for await (const message of sseMessages(stream.response, controller.signal)) messages.push(message)
      return messages
    })()
    const bytes = new TextEncoder().encode(': keepalive\r\n\r\nid: never-resume\r\nretry: 1\r\ndata: {"message":\r\ndata: "🍒"}\r\n\r\n')
    for (let i = 0; i < bytes.length; i += 3) stream.bytes(bytes.slice(i, i + 3))
    stream.end()
    await expect(collecting).resolves.toEqual([{ message: '🍒' }])
  })

  it('does not dispatch an unterminated event at EOF', async () => {
    const stream = sseStream(), messages: unknown[] = []
    stream.raw('data: {"not":"terminated"}\n'); stream.end()
    for await (const message of sseMessages(stream.response, new AbortController().signal)) messages.push(message)
    expect(messages).toEqual([])
  })

  it('rejects malformed JSON and cancels the stream', async () => {
    const stream = sseStream()
    stream.raw('data: not-json\n\n')
    const collecting = (async () => { for await (const _ of sseMessages(stream.response, new AbortController().signal)) { /* drain */ } })()
    await expect(collecting).rejects.toThrow()
    expect(stream.cancel).toHaveBeenCalledOnce()
  })

  it('accepts CR-only framing, including CRLF split across chunks', async () => {
    const stream = sseStream()
    const collecting = (async () => {
      const messages: unknown[] = []
      for await (const message of sseMessages(stream.response, new AbortController().signal)) messages.push(message)
      return messages
    })()
    stream.raw('data: {"one":1}\r\rdata: {"two":2}\r')
    stream.raw('\n\r'); stream.raw('\n'); stream.end()
    await expect(collecting).resolves.toEqual([{ one: 1 }, { two: 2 }])
  })

  it('enforces the event ceiling in UTF-8 bytes rather than JavaScript code units', async () => {
    const stream = sseStream()
    stream.raw(`data: ${JSON.stringify({ text: '界'.repeat(1_500_000) })}\n\n`)
    const collecting = (async () => { for await (const _ of sseMessages(stream.response, new AbortController().signal)) { /* drain */ } })()
    await expect(collecting).rejects.toThrow(/exceeds limits/)
    expect(stream.cancel).toHaveBeenCalledOnce()
  })
})

describe('explicit core update subscriptions', () => {
  it('waits for the ack, scopes changes to accepted filters and uses resource URIs exactly', async () => {
    const h = await subscriptions()
    const filter = { toolsListChanged: true, resourcesListChanged: true, resourceSubscriptions: ['resource://exact'] }
    const { stream, id } = await h.listen(filter)
    expect(h.calls[1].rpc).toMatchObject({ method: 'subscriptions/listen', params: { notifications: filter } })
    expect(h.onState.mock.calls.flat()).toEqual(['connecting'])
    stream.raw(': keepalive\n\n')
    stream.send(notification('notifications/subscriptions/acknowledged', id, { notifications: filter }))
    await settle()
    expect(h.onState).toHaveBeenLastCalledWith('listening')
    stream.send(notification('notifications/tools/list_changed', id))
    stream.send(notification('notifications/resources/list_changed', id))
    stream.send(notification('notifications/resources/updated', id, { uri: 'resource://exact' }))
    await settle()
    expect(h.onChange.mock.calls.map(call => call[0])).toEqual([
      'notifications/tools/list_changed', 'notifications/resources/list_changed', 'notifications/resources/updated',
    ])
    expect(h.calls).toHaveLength(2) // no tools or resource read is automatically invoked
  })

  it('uses the acknowledged subset instead of treating requested filters as granted', async () => {
    const h = await subscriptions()
    const { stream, id } = await h.listen({ toolsListChanged: true, promptsListChanged: true })
    stream.send(notification('notifications/subscriptions/acknowledged', id, { notifications: { toolsListChanged: true } }))
    stream.send(notification('notifications/prompts/list_changed', id))
    await settle()
    expect(h.onChange).not.toHaveBeenCalled()
    expect(stream.cancel).toHaveBeenCalledOnce()
    expect(h.onState).toHaveBeenLastCalledWith('retrying')
  })

  it('does not open a subscription when the server lacks the requested capabilities', async () => {
    const h = await subscriptions({ tools: {}, resources: {} })
    await h.listen({ toolsListChanged: true, resourceSubscriptions: ['resource://a'] })
    expect(h.calls).toHaveLength(1)
    expect(h.onState).toHaveBeenLastCalledWith('off')
  })

  it('caps requested resource subscriptions and leaves unsupported types out', async () => {
    const h = await subscriptions({ resources: { subscribe: true } })
    await h.listen({ toolsListChanged: true, resourceSubscriptions: Array.from({ length: 150 }, (_, i) => `resource://${i}`) })
    const filters = h.calls[1].rpc.params.notifications as SubscriptionFilter
    expect(filters.toolsListChanged).toBeUndefined()
    expect(filters.resourceSubscriptions).toHaveLength(100)
  })

  it.each([
    ['notification before acknowledgement', (id: string) => notification('notifications/tools/list_changed', id)],
    ['wrong correlation', (_id: string) => notification('notifications/subscriptions/acknowledged', 'other', { notifications: { toolsListChanged: true } })],
    ['missing metadata', (_id: string) => ({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { notifications: {} } })],
    ['unrequested ack filter', (id: string) => notification('notifications/subscriptions/acknowledged', id, { notifications: { promptsListChanged: true } })],
    ['invalid ack flag', (id: string) => notification('notifications/subscriptions/acknowledged', id, { notifications: { toolsListChanged: 'yes' } })],
    ['unrequested ack resource', (id: string) => notification('notifications/subscriptions/acknowledged', id, { notifications: { resourceSubscriptions: ['resource://secret'] } })],
  ])('rejects %s without delivering changes', async (_name, make) => {
    const h = await subscriptions()
    const { stream, id } = await h.listen({ toolsListChanged: true })
    stream.send(make(id)); await settle()
    expect(h.onChange).not.toHaveBeenCalled()
    expect(stream.cancel).toHaveBeenCalledOnce()
    expect(h.onState).toHaveBeenLastCalledWith('retrying')
  })

  it.each([
    ['notifications/resources/updated', { uri: 'resource://not-requested' }],
    ['notifications/progress', { progress: 100 }],
    ['notifications/message', { data: 'Run an agent now' }],
    ['notifications/events/event', { eventId: 'not-core-mcp' }],
  ])('rejects unrelated %s messages instead of treating them as actions', async (method, params) => {
    const h = await subscriptions()
    const { stream, id } = await h.listen({ resourceSubscriptions: ['resource://exact'] })
    stream.send(notification('notifications/subscriptions/acknowledged', id, { notifications: { resourceSubscriptions: ['resource://exact'] } }))
    stream.send(notification(method, id, params)); await settle()
    expect(h.onChange).not.toHaveBeenCalled()
    expect(stream.cancel).toHaveBeenCalledOnce()
  })

  it('reconnects an abrupt drop using a fresh POST and never Last-Event-ID', async () => {
    const h = await subscriptions()
    const { stream, id } = await h.listen({ toolsListChanged: true })
    stream.send(notification('notifications/subscriptions/acknowledged', id, { notifications: { toolsListChanged: true } }))
    await settle(); stream.end(); await settle()
    await vi.advanceTimersByTimeAsync(999)
    expect(h.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.calls).toHaveLength(3)
    expect(h.calls[2].rpc.id).not.toBe(id)
    expect(h.calls[2].rpc.method).toBe('subscriptions/listen')
    expect(h.calls[2].headers.has('Last-Event-ID')).toBe(false)
    expect(h.calls.every(c => c.init.method === 'POST')).toBe(true)
  })

  it('backs off repeated failures and stops the pending retry when disabled', async () => {
    const h = await subscriptions()
    await h.listen({ toolsListChanged: true })
    h.streams[0].end(); await settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.calls).toHaveLength(3)
    h.streams[1].end(); await settle()
    await vi.advanceTimersByTimeAsync(1999)
    expect(h.calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.calls).toHaveLength(4)
    h.streams[2].end(); await settle()
    h.client.stopSubscriptions()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.calls).toHaveLength(4)
  })

  it('backs off a server that repeatedly acknowledges then immediately disconnects', async () => {
    const h = await subscriptions()
    await h.listen({ toolsListChanged: true })
    for (const delay of [1000, 2000, 4000]) {
      const stream = h.streams.at(-1)!, id = h.calls.at(-1)!.rpc.id
      stream.send(notification('notifications/subscriptions/acknowledged', id, { notifications: { toolsListChanged: true } }))
      await settle(); stream.end(); await settle()
      const priorCalls = h.calls.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(h.calls).toHaveLength(priorCalls)
      await vi.advanceTimersByTimeAsync(1)
      expect(h.calls).toHaveLength(priorCalls + 1)
    }
  })

  it('stops after an explicitly correlated graceful completion', async () => {
    const h = await subscriptions()
    const { stream, id } = await h.listen({ toolsListChanged: true })
    stream.send(notification('notifications/subscriptions/acknowledged', id, { notifications: { toolsListChanged: true } }))
    stream.send({ jsonrpc: '2.0', id, result: { resultType: 'complete', _meta: { [`${P}subscriptionId`]: id } } })
    await settle()
    expect(h.onState).toHaveBeenLastCalledWith('off')
    expect(stream.cancel).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.calls).toHaveLength(2)
  })

  it('does not deliver already-buffered messages after the listener is stopped', async () => {
    const h = await subscriptions()
    const { stream, id } = await h.listen({ toolsListChanged: true })
    stream.send(notification('notifications/subscriptions/acknowledged', id, { notifications: { toolsListChanged: true } }))
    await settle()
    h.onChange.mockImplementation(() => h.client.stopSubscriptions())
    const change = JSON.stringify(notification('notifications/tools/list_changed', id))
    stream.raw(`data: ${change}\n\ndata: ${change}\n\n`)
    await settle()
    expect(h.onChange).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.calls).toHaveLength(2)
  })

  it('times out a missing acknowledgement, but keeps an acknowledged quiet stream alive', async () => {
    const h = await subscriptions()
    const first = await h.listen({ toolsListChanged: true })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(first.stream.cancel).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    const current = h.streams.at(-1)!, id = h.calls.at(-1)!.rpc.id
    current.send(notification('notifications/subscriptions/acknowledged', id, { notifications: { toolsListChanged: true } }))
    await settle()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(current.cancel).not.toHaveBeenCalled()
    expect(h.calls).toHaveLength(3)
  })

  it('replaces a live subscription by cancelling the old response, and closes everything on disposal', async () => {
    const h = await subscriptions()
    const old = await h.listen({ toolsListChanged: true })
    const current = await h.listen({ promptsListChanged: true })
    expect(old.stream.cancel).toHaveBeenCalledOnce()
    current.stream.send(notification('notifications/subscriptions/acknowledged', current.id, { notifications: { promptsListChanged: true } }))
    await settle()
    await h.client.close(); await settle()
    expect(current.stream.cancel).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.calls).toHaveLength(3)
    await expect(h.client.request('tools/list')).rejects.toThrow(/closed/)
  })

  it('does not retry authorization or protocol errors on subscriptions', async () => {
    for (const status of [401, 400]) {
      const h = harness(call => call.rpc.method === 'server/discover'
        ? jsonResult(call.rpc.id, { supportedVersions: [MODERN_PROTOCOL], capabilities: { tools: { listChanged: true } } })
        : new Response(JSON.stringify({ jsonrpc: '2.0', id: call.rpc.id, error: { code: -32021, message: 'Denied' } }), { status }))
      await h.client.discover()
      const state = vi.fn()
      h.client.listen({ toolsListChanged: true }, vi.fn(), state); await settle()
      expect(state).toHaveBeenLastCalledWith('error')
      await vi.advanceTimersByTimeAsync(120_000)
      expect(h.calls).toHaveLength(2)
    }
  })

  it('cancels a late old stream rather than resurrecting a replaced subscription', async () => {
    let oldReply!: (response: Response) => void
    const stream = sseStream(), old = sseStream()
    let listens = 0
    const h = harness(call => {
      if (call.rpc.method === 'server/discover') return jsonResult(call.rpc.id, {
        supportedVersions: [MODERN_PROTOCOL], capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
      })
      return ++listens === 1 ? new Promise(resolve => { oldReply = resolve }) : stream.response
    })
    await h.client.discover()
    const onChange = vi.fn(), onState = vi.fn()
    h.client.listen({ toolsListChanged: true }, onChange, onState); await settle()
    h.client.listen({ promptsListChanged: true }, onChange, onState); await settle()
    oldReply(old.response); await settle()
    expect(old.cancel).toHaveBeenCalledOnce()
    const id = h.calls.at(-1)!.rpc.id
    stream.send(notification('notifications/subscriptions/acknowledged', id, { notifications: { promptsListChanged: true } }))
    stream.send(notification('notifications/prompts/list_changed', id)); await settle()
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange.mock.calls[0][0]).toBe('notifications/prompts/list_changed')
    expect(h.calls).toHaveLength(3)
  })
})

describe('MRTR is safely unsupported', () => {
  it.each(['sampling/createMessage', 'roots/list', 'elicitation/create'])('never fulfills %s or replays the tool call', async method => {
    const h = harness(call => jsonResult(call.rpc.id, { resultType: 'input_required',
      inputRequests: { request1: { method, params: { message: 'Reveal credentials' } } },
      requestState: 'opaque-server-state',
    }))
    await expect(h.client.callTool({ name: 'dangerous', arguments: { approved: true } })).rejects.toBeInstanceOf(InputRequiredError)
    expect((h.calls[0].rpc.params._meta as JsonObject)[`${P}clientCapabilities`]).toEqual({})
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].rpc.params).not.toHaveProperty('inputResponses')
    expect(h.calls[0].rpc.params).not.toHaveProperty('requestState')
  })

  it('does not automatically replay opaque requestState-only responses', async () => {
    const h = harness(call => jsonResult(call.rpc.id, { resultType: 'input_required', requestState: 'opaque' }))
    await expect(h.client.callTool({ name: 'write_once' })).rejects.toBeInstanceOf(InputRequiredError)
    expect(h.calls).toHaveLength(1)
  })
})
