import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import { deleteMcpTasks, getMcpTask, mcpConfigHash, updateMcpTask, type StoredMcpTask } from '../data/mcpTasks'
import { pollMcpTasks } from './mcpTasks'
const state = vi.hoisted(() => ({ settings: {} as any, status: vi.fn(), result: vi.fn(), connect: vi.fn(), close: vi.fn(), transport: vi.fn() }))
vi.mock('../data/settings', () => ({ loadSettings: async () => state.settings }))
vi.mock('../mcp/auth', () => ({ ChromeOAuthProvider: class {} }))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  connect = state.connect
  close = state.close
  experimental = { tasks: { getTask: state.status, getTaskResult: state.result } }
} }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class { constructor(...args: unknown[]) { state.transport(...args) } setProtocolVersion() {} } }))
let record: StoredMcpTask
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  await deleteMcpTasks(); vi.clearAllMocks()
  state.settings = { mcp: { servers: { srv: { url: 'https://a.test/mcp' } } } }
  record = { id: 'one', conversationId: 'chat', server: 'srv', tool: 'job', configHash: await mcpConfigHash(state.settings.mcp.servers.srv), sessionId: 'original-session', args: {}, createdAt: Date.now(), nextPollAt: 0,
    task: { taskId: 'remote', status: 'working', createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttl: null } }
  state.connect.mockResolvedValue(undefined); state.close.mockResolvedValue(undefined)
  state.status.mockResolvedValue({ ...record.task, status: 'completed' })
  state.result.mockResolvedValue({ content: [{ type: 'text', text: 'done' }] })
  await updateMcpTask(record.id, () => record)
})
it('polls without a panel, preserves the server session and caches a final result', async () => {
  await pollMcpTasks()
  expect(state.transport.mock.calls[0][1]).toMatchObject({ sessionId: 'original-session' })
  expect(await getMcpTask('one')).toMatchObject({ ready: true, result: { content: [{ text: 'done' }] } })
  expect(state.close).toHaveBeenCalled()
  await pollMcpTasks()
  expect(state.status).toHaveBeenCalledTimes(1)
})
it('respects pollInterval and does not retrieve unfinished results', async () => {
  state.status.mockResolvedValue({ ...record.task, pollInterval: 120000 })
  await pollMcpTasks(); await pollMcpTasks()
  expect(state.status).toHaveBeenCalledTimes(1)
  expect(state.result).not.toHaveBeenCalled()
  expect((await getMcpTask('one'))!.nextPollAt).toBeGreaterThan(Date.now() + 110000)
})
it('retries transient failures without creating another tool call', async () => {
  state.status.mockRejectedValue(new Error('offline'))
  await pollMcpTasks()
  expect(await getMcpTask('one')).toMatchObject({ error: 'offline' })
  expect((await getMcpTask('one'))!.ready).not.toBe(true)
})
it('does not contact a disabled or replaced server', async () => {
  state.settings.mcp.serverState = { srv: { enabled: false } }
  await pollMcpTasks()
  expect(state.connect).not.toHaveBeenCalled()
  state.settings.mcp.serverState = {}
  state.settings.mcp.servers.srv.url = 'https://other.test/mcp'
  await pollMcpTasks()
  expect(state.connect).not.toHaveBeenCalled()
  expect(await getMcpTask('one')).toBeUndefined()
})
it('does not resurrect records deleted during a network request', async () => {
  state.status.mockImplementation(async () => { await deleteMcpTasks('chat'); return { ...record.task, status: 'completed' } })
  await pollMcpTasks()
  expect(await getMcpTask('one')).toBeUndefined()
})
it('queues failed and cancelled outcomes without fetching their results', async () => {
  state.status.mockResolvedValue({ ...record.task, status: 'failed', statusMessage: 'job failed' })
  await pollMcpTasks()
  expect(await getMcpTask('one')).toMatchObject({ ready: true, error: 'job failed' })
  expect(state.result).not.toHaveBeenCalled()
})
