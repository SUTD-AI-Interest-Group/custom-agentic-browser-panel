import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeChatRun, chatRunChanges, chatRunMessages, consumeToolRequest, createChatRun, createChatRunReader, getChatRun, getChatRunLive,
  listChatRuns, removeChatRuns, updateChatRun, type ChatRun,
} from './chatRuns'
import { deleteConversation, saveConversation } from './conversations'

function run(id = 'run'): ChatRun {
  return {
    id, conversationId: 'chat', owner: 'panel', ownerUntil: 100,
    assistantId: 'answer', modelId: 'fixture', system: 'Answer.', history: [{ role: 'user', content: 'Question' }],
    messages: [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'Question' }] }],
    baseParts: [], tools: [{ name: 'ReadPage', inputSchema: { type: 'object' } }], images: [], parts: [], state: 'running', updatedAt: 1,
    toolRequests: [], steps: [],
  }
}
beforeEach(() => removeChatRuns())

/** The raw record in one object store, read straight from IndexedDB. */
function raw(store: 'runs' | 'live', key = 'chat'): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('lychee-chat-runs')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const req = open.result.transaction(store).objectStore(store).get(key)
      req.onsuccess = () => { open.result.close(); resolve(req.result) }
      req.onerror = () => reject(req.error)
    }
  })
}

describe('durable chat storage', () => {
  it('preserves concurrent host updates and panel tool results', async () => {
    await createChatRun(run())
    await Promise.all([
      updateChatRun('chat', old => ({ ...old, parts: [{ type: 'text', text: 'Streaming' }] })),
      updateChatRun('chat', old => ({ ...old, toolRequests: [{ id: 'tool', name: 'ToolSearch', input: {}, state: 'done', output: { found: true } }] })),
      updateChatRun('chat', old => ({ ...old, ownerUntil: 999 })),
    ])
    const saved = await getChatRun('chat')
    expect(saved?.parts).toEqual([{ type: 'text', text: 'Streaming' }])
    expect(saved?.toolRequests[0].output).toEqual({ found: true })
    expect(saved?.ownerUntil).toBe(999)
  })

  it('rejects a second active run atomically, and allows a new one once the first has finished', async () => {
    const outcomes = await Promise.allSettled([createChatRun(run('a')), createChatRun(run('b'))])
    expect(outcomes.map(o => o.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult).reason.message).toMatch(/already generating/)
    expect((await listChatRuns()).length).toBe(1)
    const first = (await getChatRun('chat'))!
    // The refused run left nothing behind — neither half.
    expect(first.id === 'a' || first.id === 'b').toBe(true)
    await updateChatRun('chat', old => ({ ...old, state: 'done' }))
    await createChatRun(run('c'))
    expect((await getChatRun('chat'))?.id).toBe('c')
  })

  it('does not resurrect a deleted run when a late host write arrives', async () => {
    await createChatRun(run())
    await saveConversation({ id: 'chat', messages: [], history: [] })
    await deleteConversation('chat')
    await updateChatRun('chat', old => old?.id === 'run' ? { ...old, state: 'done' } : old)
    expect(await getChatRun('chat')).toBeUndefined()
    expect(await getChatRunLive('chat')).toBeUndefined()
  })

  it('replaces the assistant bubble while preserving previous cycles and usage', () => {
    const job = run()
    job.messages.push({ id: 'answer', role: 'assistant', parts: [], usage: { totalTokens: 10 } })
    job.baseParts = [{ type: 'text', text: 'Earlier cycle' }]
    job.parts = [{ type: 'text', text: 'Final cycle' }]
    job.result = { parts: job.parts, responseMessages: [], stop: { reason: 'completed', stepsUsed: 1 }, usage: { totalTokens: 7 } }
    const messages = chatRunMessages(job)
    expect(messages).toHaveLength(2)
    expect(messages[1].parts).toEqual([...job.baseParts, ...job.parts])
    expect(messages[1].usage?.totalTokens).toBe(17)
  })

  it('a @driver run adds no usage (its zeros are not chat-model tokens) and keeps the driver mark, panel open or not', () => {
    const job = run()
    job.driver = { goal: 'add the mug', values: {} }
    job.parts = [{ type: 'text', text: 'Done in 2 steps.' }]
    job.result = { parts: job.parts, responseMessages: [], stop: { reason: 'completed', stepsUsed: 3 }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
    const bubble = chatRunMessages(job).at(-1)!
    expect(bubble.usage).toBeUndefined()
    expect(bubble.driver).toBe(true)
    // A bubble the panel already counted keeps exactly what it had.
    job.messages = [...job.messages, { id: 'answer', role: 'assistant', parts: [], driver: true }]
    expect(chatRunMessages(job).at(-1)).toMatchObject({ driver: true, parts: job.parts })
    expect(chatRunMessages(job).at(-1)?.usage).toBeUndefined()
  })

  it('keeps partial text and shows a generation error on restoration', () => {
    const job = run()
    job.parts = [{ type: 'text', text: 'Partial reply' }]
    job.error = 'Host interrupted'
    expect(chatRunMessages(job).at(-1)?.parts).toEqual([
      { type: 'text', text: 'Partial reply' }, { type: 'text', text: '**Error:** Host interrupted' },
    ])
  })
})

describe('the spec/live split', () => {
  it('stores each half on its own side, and a whole run reads back exactly as it was created', async () => {
    const created = run()
    created.driver = { goal: 'add the mug', values: {} }
    created.activeNames = ['ReadPage']
    await createChatRun(created)
    const spec = (await raw('runs'))!, live = (await raw('live'))!
    expect(Object.keys(spec).sort()).toEqual(['assistantId', 'baseParts', 'conversationId', 'driver', 'history', 'id', 'images', 'messages', 'modelId', 'system', 'tools'])
    expect(live).not.toHaveProperty('history')
    expect(live).not.toHaveProperty('messages')
    expect(live).not.toHaveProperty('tools')
    expect(live.activeNames).toEqual(['ReadPage'])
    expect(await getChatRun('chat')).toEqual({ ...created, partsVersion: 1 })
    const half = await getChatRunLive('chat')
    expect(half).not.toHaveProperty('history')
    expect(half?.state).toBe('running')
  })

  it('an update writes only the live half, even when handed a whole run back', async () => {
    await createChatRun(run())
    const before = await raw('runs')
    // A caller that spreads a merged run (or adds a spec field) must not bloat the live record.
    const merged = (await getChatRun('chat'))!
    await updateChatRun('chat', () => ({ ...merged, history: [], parts: [{ type: 'text', text: 'Hi' }] }) as never)
    for (let i = 0; i < 5; i++) await updateChatRun('chat', old => ({ ...old, parts: [...old.parts, { type: 'text', text: `${i}` }] }))
    expect(await raw('runs')).toEqual(before)
    const live = (await raw('live'))!
    expect(live).not.toHaveProperty('history')
    expect(live).not.toHaveProperty('messages')
    expect((await getChatRun('chat'))?.history).toEqual(run().history)
  })

  it('an update never creates a run', async () => {
    const change = vi.fn((old) => old)
    expect(await updateChatRun('chat', change)).toBeUndefined()
    expect(change).not.toHaveBeenCalled()
    expect(await raw('live')).toBeUndefined()
  })

  it('removing deletes both halves and announces each removed conversation', async () => {
    const events: string[] = []
    const unsubscribe = chatRunChanges.subscribe(id => events.push(id))
    try {
      await createChatRun(run())
      await createChatRun({ ...run('other'), conversationId: 'chat-2' })
      events.length = 0
      await removeChatRuns('chat')
      expect(await raw('runs')).toBeUndefined()
      expect(await raw('live')).toBeUndefined()
      expect(await getChatRun('chat-2')).toBeDefined()
      await removeChatRuns()
      expect(await raw('runs', 'chat-2')).toBeUndefined()
      expect(await raw('live', 'chat-2')).toBeUndefined()
      expect(events).toEqual(['chat', 'chat-2'])
    } finally { unsubscribe() }
  })
})

describe('consumeToolRequest', () => {
  const big = 'x'.repeat(50_000)
  const withRequests = (): ChatRun => ({
    ...run(),
    toolRequests: [
      { id: 'a', name: 'ReadPage', input: { mode: 'text', reason: 'r' }, state: 'done', output: { text: big }, images: [{ dataUrl: `data:image/png;base64,${big}`, caption: 'shot' }], activeNames: ['ReadPage'], parked: false },
      { id: 'b', name: 'RunCode', input: { code: '1+1' }, state: 'executing' },
    ],
  })

  it('drops a taken result’s copy, keeping only what stops it running again', async () => {
    await createChatRun(withRequests())
    await updateChatRun('chat', (old) => consumeToolRequest(old, 'a'))
    const live = (await getChatRunLive('chat'))!
    expect(live.toolRequests[0]).toEqual({ id: 'a', name: 'ReadPage', state: 'done' })
    // Another request — still in flight — is untouched.
    expect(live.toolRequests[1]).toEqual({ id: 'b', name: 'RunCode', input: { code: '1+1' }, state: 'executing' })
    expect(JSON.stringify(await raw('live')).length).toBeLessThan(2_000)
  })

  it('never strips a request that has not finished, and writes nothing a second time', async () => {
    const events: string[] = []
    await createChatRun(withRequests())
    const unsubscribe = chatRunChanges.subscribe((id) => events.push(id))
    try {
      const start = (await getChatRunLive('chat'))!
      expect(consumeToolRequest(start, 'b')).toBe(start)
      expect(consumeToolRequest(start, 'missing')).toBe(start)
      await updateChatRun('chat', (old) => consumeToolRequest(old, 'a'))
      await updateChatRun('chat', (old) => consumeToolRequest(old, 'a'))
      expect(events).toEqual(['chat'])
    } finally { unsubscribe() }
  })
})

describe('createChatRunReader', () => {
  const specGets = { count: 0 }
  const get = IDBObjectStore.prototype.get
  beforeEach(() => {
    specGets.count = 0
    IDBObjectStore.prototype.get = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      if (this.name === 'runs') specGets.count++
      return get.call(this, key)
    }
  })
  afterEach(() => { IDBObjectStore.prototype.get = get })

  it('reads a run’s spec once, then only its live half, and re-reads it for a new run', async () => {
    await createChatRun(run('first'))
    const read = createChatRunReader()
    expect((await read('chat'))?.history).toEqual(run().history)
    for (let i = 0; i < 5; i++) {
      await updateChatRun('chat', old => ({ ...old, parts: [{ type: 'text', text: `${i}` }] }))
      expect((await read('chat'))?.parts).toEqual([{ type: 'text', text: `${i}` }])
    }
    expect(specGets.count).toBe(1)
    await removeChatRuns('chat')
    expect(await read('chat')).toBeUndefined()
    await createChatRun({ ...run('second'), history: [{ role: 'user', content: 'Another' }] })
    expect((await read('chat'))?.history).toEqual([{ role: 'user', content: 'Another' }])
    expect(specGets.count).toBe(2)
  })
})

it('publishes only committed changes and advances reply versions only for changed parts', async () => {
  const events: string[] = []
  const unsubscribe = chatRunChanges.subscribe(id => events.push(id))
  try {
    const created = await createChatRun(run())
    await updateChatRun('chat', old => old)
    const heartbeat = await updateChatRun('chat', old => ({ ...old, ownerUntil: 1234 }))
    expect(heartbeat?.partsVersion).toBe(created.partsVersion)
    const reply = await updateChatRun('chat', old => ({ ...old, parts: [{ type: 'text', text: 'New' }] }))
    expect(reply?.partsVersion).toBe(created.partsVersion! + 1)
    await expect(updateChatRun('chat', () => { throw new Error('abort') })).rejects.toThrow('abort')
    expect(events).toEqual(['chat', 'chat', 'chat'])
    expect((await getChatRun('chat'))?.parts).toEqual(reply?.parts)
    expect(activeChatRun(await getChatRunLive('chat'))).toBe(true)
  } finally { unsubscribe() }
})
