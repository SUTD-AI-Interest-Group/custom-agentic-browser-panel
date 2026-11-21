import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getChatRun, listChatRuns, removeChatRuns, updateChatRun, type ChatRun } from '../data/chatRuns'
const fixture = vi.hoisted(() => ({ policy: 'ask', mutations: 0, disconnect: vi.fn(), decider: undefined as { mode: string } | undefined, send: (() => {}) as (msg: unknown) => unknown }))
vi.mock('../data/settings', () => ({
  loadSettings: async () => ({ providers: [], tabAccess: 'all-tabs', toolPolicies: { Execute: fixture.policy }, decider: fixture.decider }),
  toolPolicy: () => fixture.policy,
}))
vi.mock('../tools/tools', () => ({ createAgentTools: (approve: (r: unknown) => Promise<boolean>, _access: unknown, _capabilities: unknown, control: any, ...rest: any[]) => ({
  Control: { execute: async () => ({ allowed: await control.requestSession({ plan: 'Fixture', host: 'example.com', origin: 'https://example.com', tabId: 7 }) }) },
  // Stands in for ControlPage: hands its step to the decider argument (createAgentTools' last).
  Observe: { execute: async () => {
    rest[9]?.observeStep({
      tabId: 7,
      snap: { url: 'https://example.com/', title: 'Fixture', origin: 'https://example.com', dpr: 1, text: '', truncated: false,
        elements: [{ index: 0, tag: 'input', type: 'password', name: 'Password', value: 'hunter2', sensitive: true, rect: { x: 0, y: 0, width: 1, height: 1 } }] },
      spec: { action: 'type', index: 0, text: 'hunter2' },
      session: { tabId: 7, origin: 'https://example.com', plan: 'Fixture', active: true },
    })
    return { observed: true }
  } },
  Execute: { execute: async (input: { once?: boolean }) => {
    const allowed = await approve({ toolName: 'Execute', summary: 'Make a change', reason: 'Fixture', once: input.once })
    if (allowed) fixture.mutations++
    return { allowed }
  } },
}) }))
vi.mock('../platform/permissions', () => ({ grantedCapabilities: async () => new Set() }))
vi.mock('../platform/splitView', () => ({ splitPartnerOf: async () => undefined }))
vi.mock('../platform/presence', () => ({ unmountPresence: async () => {} }))
vi.mock('../mcp/manager', () => ({ getMcpManager: () => ({ refresh: async () => {}, ready: async () => {}, disconnectAll: fixture.disconnect }) }))
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
  await removeChatRuns(); fixture.mutations = 0; fixture.policy = 'ask'; fixture.decider = undefined; fixture.send = () => {}
  vi.stubGlobal('chrome', { runtime: { id: 'fixture', getURL: url, sendMessage: (msg: unknown) => fixture.send(msg), onMessage: { addListener: (fn: typeof listener) => { listener = fn } } }, notifications: { create: vi.fn(async () => 'notice') } })
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
  it('forwards a page step to the panel decider for this conversation, without the typed value', async () => {
    fixture.policy = 'always'; fixture.decider = { mode: 'shadow' }
    const sent: any[] = []
    fixture.send = (msg) => { sent.push(msg); return Promise.resolve() }
    const run = job(); run.toolRequests[0].name = 'Observe'
    await updateChatRun('chat', () => run); await poll(run); await finished()
    expect((await getChatRun('chat'))?.toolRequests[0].output).toEqual({ observed: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'decider.step', conversationId: 'chat', step: { tabId: 7, spec: { action: 'type', index: 0 } } })
    expect(JSON.stringify(sent)).not.toContain('hunter2')
  })
  it('a missing panel (or the decider off) never changes the tool result', async () => {
    fixture.policy = 'always'; fixture.decider = { mode: 'shadow' }
    fixture.send = () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'))
    const run = job(); run.toolRequests[0].name = 'Observe'
    await updateChatRun('chat', () => run); await poll(run); await finished()
    expect((await getChatRun('chat'))?.toolRequests[0]).toMatchObject({ output: { observed: true }, error: undefined })

    releaseChatTools('chat', run.id)
    fixture.decider = { mode: 'off' }
    const sent: unknown[] = []
    fixture.send = (msg) => { sent.push(msg) }
    const off = job(); off.toolRequests[0].name = 'Observe'
    await updateChatRun('chat', () => off); await poll(off); await finished()
    expect(sent).toEqual([])
  })
  it('does not replay a call left executing by a lost worker', async () => {
    const run = job(); run.toolRequests[0].state = 'executing'
    await updateChatRun('chat', () => run); await poll(run); await finished()
    expect(fixture.mutations).toBe(0)
    expect((await getChatRun('chat'))?.toolRequests[0].error).toContain('outcome is unknown')
  })
})
