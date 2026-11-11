import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { deleteMcpTasks } from '../data/mcpTasks'
// Real MCP SDK client and schemas, with only the HTTP transport replaced.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { JSONRPCMessage, Task } from '@modelcontextprotocol/sdk/types.js'
import { McpManager } from './manager'
import type { Settings } from '../data/settings'

const wire = vi.hoisted(() => ({ transport: null as unknown }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class { constructor() { return wire.transport as object } },
}))
let manager: McpManager
let messages: JSONRPCMessage[]
let task: Task
let supportsTasks = true
let support: 'required' | 'optional' | 'forbidden' = 'required'
let calls = 0
const settings = { mcp: { servers: { srv: { url: 'https://example.test/mcp' } } } } as unknown as Settings

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
  vi.stubGlobal('crypto', webcrypto)
  await deleteMcpTasks()
  messages = []; calls = 0; supportsTasks = true; support = 'required'
  task = { taskId: 'job-1', status: 'working', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttl: 60000, pollInterval: 1000 }
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } } })
  const [client, server] = InMemoryTransport.createLinkedPair()
  wire.transport = client
  server.onmessage = (message) => {
    messages.push(message)
    if (!('id' in message) || !('method' in message)) return
    let result: Record<string, unknown> = {}
    if (message.method === 'initialize') result = {
      protocolVersion: '2025-11-25', serverInfo: { name: 'fixture', version: '1' },
      capabilities: { tools: {}, ...(supportsTasks ? { tasks: { requests: { tools: { call: {} } }, cancel: {} } } : {}) },
    }
    if (message.method === 'tools/list') result = { tools: [{ name: 'job', inputSchema: { type: 'object' }, execution: { taskSupport: support } }] }
    if (message.method === 'tools/call') { calls++; result = message.params?.task ? { task } : { content: [{ type: 'text', text: 'sync' }] } }
    if (message.method === 'tasks/get') result = task
    if (message.method === 'tasks/result') result = { content: [{ type: 'text', text: 'done' }], _meta: { appSecret: 'widget-only' } }
    if (message.method === 'tasks/cancel') { task = { ...task, status: 'cancelled' }; result = task }
    void server.send({ jsonrpc: '2.0', id: message.id, result })
  }
  manager = new McpManager()
})
afterEach(() => { manager.disconnectAll(); vi.unstubAllGlobals() })
async function connect() { await manager.refresh(settings); await manager.ensureConnected('srv') }

it('advertises Apps, preserves task metadata, and returns before polling', async () => {
  await connect()
  const init = messages.find((m) => 'method' in m && m.method === 'initialize') as { params: any }
  expect(init.params.capabilities.extensions['io.modelcontextprotocol/ui'].mimeTypes).toContain('text/html;profile=mcp-app')
  expect(manager.runtime()[0].tools[0].taskSupport).toBe('required')
  expect(await manager.startTool('srv', 'job', { q: 1 }, 'chat')).toEqual({ task })
  expect(messages.some((m) => 'method' in m && m.method === 'tasks/get')).toBe(false)
  expect(calls).toBe(1)
})

it('checks without blocking, then retrieves the final MCP result without resubmitting', async () => {
  await connect(); await manager.startTool('srv', 'job', { q: 1 }, 'chat')
  expect(await manager.legacyTaskOperation('srv', 'job', 'chat', task.taskId, 'result')).toEqual({ task })
  expect(messages.some((m) => 'method' in m && m.method === 'tasks/result')).toBe(false)
  task = { ...task, status: 'completed' }
  expect(await manager.legacyTaskOperation('srv', 'job', 'chat', task.taskId, 'result')).toMatchObject({ result: { _meta: { appSecret: 'widget-only' } }, args: { q: 1 } })
  expect(calls).toBe(1)
})

it('rejects handles from another chat or tool before contacting the server', async () => {
  await connect(); await manager.startTool('srv', 'job', {}, 'chat')
  const count = messages.length
  await expect(manager.legacyTaskOperation('srv', 'job', 'other-chat', task.taskId, 'cancel')).rejects.toThrow('unavailable')
  await expect(manager.legacyTaskOperation('srv', 'other-tool', 'chat', task.taskId, 'result')).rejects.toThrow('unavailable')
  expect(messages).toHaveLength(count)
})

it('cancels through the task API', async () => {
  await connect(); await manager.startTool('srv', 'job', {}, 'chat')
  expect(await manager.legacyTaskOperation('srv', 'job', 'chat', task.taskId, 'cancel')).toMatchObject({ task: { status: 'cancelled' } })
  expect(calls).toBe(1)
})

it('does not silently execute a required task synchronously without capabilities', async () => {
  supportsTasks = false; await connect()
  await expect(manager.startTool('srv', 'job', {}, 'chat')).rejects.toThrow('does not advertise')
  expect(calls).toBe(0)
})

it('uses normal calls for optional tasks when the server lacks task capabilities', async () => {
  supportsTasks = false; support = 'optional'; await connect()
  expect(await manager.startTool('srv', 'job', {}, 'chat')).toMatchObject({ result: { content: [{ text: 'sync' }] } })
})

it('does not recreate a job after a failed status request', async () => {
  await connect(); await manager.startTool('srv', 'job', {}, 'chat')
  const abort = new AbortController(); abort.abort()
  await expect(manager.legacyTaskOperation('srv', 'job', 'chat', task.taskId, 'status', abort.signal)).rejects.toBeDefined()
  expect(calls).toBe(1)
})
