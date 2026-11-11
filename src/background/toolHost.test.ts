import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getChatRun, listChatRuns, removeChatRuns, updateChatRun, type ChatRun } from '../data/chatRuns'
const fixture = vi.hoisted(() => ({ policy: 'ask', mutations: 0, disconnect: vi.fn() }))
vi.mock('../data/settings', () => ({
  loadSettings: async () => ({ providers: [], tabAccess: 'all-tabs', toolPolicies: { Execute: fixture.policy } }),
  toolPolicy: () => fixture.policy,
}))
vi.mock('../tools/tools', () => ({ createAgentTools: (approve: (r: unknown) => Promise<boolean>, _access: unknown, _capabilities: unknown, control: any) => ({
  Control: { execute: async () => ({ allowed: await control.requestSession({ plan: 'Fixture', host: 'example.com', origin: 'https://example.com', tabId: 7 }) }) },
  Execute: { execute: async (input: { once?: boolean }) => {
    const allowed = await approve({ toolName: 'Execute', summary: 'Make a change', reason: 'Fixture', once: input.once })
    if (allowed) fixture.mutations++
    return { allowed }
  } },
}) }))
vi.mock('../platform/permissions', () => ({ grantedCapabilities: async () => new Set() }))
vi.mock('../platform/splitView', () => ({ splitPartnerOf: async () => undefined }))
vi.mock('../platform/presence', () => ({ unmountPresence: async () => {} }))
vi.mock('../mcp/manager', () => ({ getMcpManager: () => ({ refresh: async () => {}, disconnectAll: fixture.disconnect }) }))
vi.mock('../mcp/tools', () => ({ buildMcpTools: () => ({}) }))
import { installToolHost, releaseChatTools, releaseDetachedSessions } from './toolHost'
let listener: (msg: unknown, sender: unknown, reply: (r: unknown) => void) => unknown
const url = (path: string) => `chrome-extension://fixture/${path}`
const message = (msg: unknown, page = 'offscreen.html') => new Promise(resolve => {
  listener(msg, { id: 'fixture', url: url(page) }, resolve)
})
async function until(test: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await test()) return; await new Promise(r => setTimeout(r, 10)) }
  throw new Error('Tool host did not settle')
}
function job(once = false): ChatRun {
  return { id: crypto.randomUUID(), conversationId: 'chat', owner: 'closed-panel', ownerUntil: 0,
    assistantId: 'assistant', modelId: 'fixture', system: '', history: [], messages: [], baseParts: [], tools: [], images: [], parts: [],
    state: 'running', updatedAt: Date.now(), steps: [], approvals: [], toolRequests: [{ id: 'call', name: 'Execute', input: { once }, state: 'requested' }],
  }
}
beforeEach(async () => {
  fixture.disconnect.mockClear()
  await removeChatRuns(); fixture.mutations = 0; fixture.policy = 'ask'
  vi.stubGlobal('chrome', { runtime: { id: 'fixture', getURL: url, onMessage: { addListener: (fn: typeof listener) => { listener = fn } } }, notifications: { create: vi.fn(async () => 'notice') } })
  installToolHost()
})
afterEach(async () => {
  for (const run of await listChatRuns()) releaseChatTools(run.conversationId, run.id)
})
const poll = (run: ChatRun) => message({ type: 'chat.tool.poll', conversationId: 'chat', id: run.id, requestId: 'call' })
const finished = () => until(async () => (await getChatRun('chat'))?.toolRequests[0].state === 'done')

describe('background tool permissions', () => {
  it('releases a parked session when its panel closes, while preserving a live run', async () => {
    const run = job(); run.windowId = 9; run.toolRequests[0].name = 'Control'
    await updateChatRun('chat', () => run); await poll(run)
    await until(async () => !!(await getChatRun('chat'))?.approvals?.length)
    const approval = (await getChatRun('chat'))!.approvals![0]
    await message({ type: 'chat.approval.decide', conversationId: 'chat', id: run.id, approvalId: approval.id, decision: true }, 'sidepanel.html')
    await finished()
    const status = () => message({ type: 'chat.tools.status', conversationId: 'chat', id: run.id })
    await releaseDetachedSessions(9)
    expect(await status()).toMatchObject({ sessionActive: true })
    await updateChatRun('chat', old => ({ ...old!, state: 'done' }))
    await message({ type: 'chat.tools.release', conversationId: 'chat', id: run.id, keepSession: true })
    await releaseDetachedSessions(10)
    expect(await status()).toMatchObject({ sessionActive: true })
    await releaseDetachedSessions(9)
    expect(await status()).toMatchObject({ sessionActive: false })
  })
  it('disconnects background MCP clients after releasing the last tool runtime', async () => {
    const run = job(); run.allowedTools = ['Execute']
    await updateChatRun('chat', () => run)
    await poll(run); await finished()
    expect(fixture.disconnect).not.toHaveBeenCalled()
    await message({ type: 'chat.tools.release', conversationId: 'chat', id: run.id, chainId: run.id })
    expect(fixture.disconnect).toHaveBeenCalledTimes(1)
  })
  it('executes an existing chat grant exactly once even with duplicate polls', async () => {
    const run = job(); run.allowedTools = ['Execute']
    await updateChatRun('chat', () => run)
    await Promise.all([poll(run), poll(run), poll(run)]); await finished()
    expect(fixture.mutations).toBe(1)
    expect((await getChatRun('chat'))?.approvals).toHaveLength(0)
  })
  it('persists a pending approval and resumes the same call after a new panel answers', async () => {
    const run = job(); await updateChatRun('chat', () => run); await poll(run)
    await until(async () => !!(await getChatRun('chat'))?.approvals?.length)
    expect(fixture.mutations).toBe(0)
    const approval = (await getChatRun('chat'))!.approvals![0]
    await message({ type: 'chat.approval.decide', conversationId: 'chat', id: run.id, approvalId: approval.id, decision: true }, 'sidepanel.html')
    await finished(); expect(fixture.mutations).toBe(1)
  })
  it('requires approval for once-only actions even under Always and honours denial', async () => {
    fixture.policy = 'always'
    const run = job(true); await updateChatRun('chat', () => run); await poll(run)
    await until(async () => !!(await getChatRun('chat'))?.approvals?.length)
    expect(fixture.mutations).toBe(0)
    const approval = (await getChatRun('chat'))!.approvals![0]
    await message({ type: 'chat.approval.decide', conversationId: 'chat', id: run.id, approvalId: approval.id, decision: false }, 'sidepanel.html')
    await finished(); expect(fixture.mutations).toBe(0)
  })
  it('Never overrides a stored chat grant', async () => {
    fixture.policy = 'never'; const run = job(); run.allowedTools = ['Execute']
    await updateChatRun('chat', () => run); await poll(run); await finished()
    expect(fixture.mutations).toBe(0)
  })
  it('does not replay a call left executing by a lost worker', async () => {
    const run = job(); run.toolRequests[0].state = 'executing'
    await updateChatRun('chat', () => run); await poll(run); await finished()
    expect(fixture.mutations).toBe(0)
    expect((await getChatRun('chat'))?.toolRequests[0].error).toContain('outcome is unknown')
  })
})
