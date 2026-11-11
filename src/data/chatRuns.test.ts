import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { activeChatRun, chatRunChanges, chatRunMessages, getChatRun, listChatRuns, removeChatRuns, updateChatRun, type ChatRun } from './chatRuns'
import { deleteConversation, saveConversation } from './conversations'

function run(): ChatRun {
  return {
    id: 'run', conversationId: 'chat', owner: 'panel', ownerUntil: 100,
    assistantId: 'answer', modelId: 'fixture', system: 'Answer.', history: [],
    messages: [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'Question' }] }],
    baseParts: [], tools: [], images: [], parts: [], state: 'running', updatedAt: 1,
    toolRequests: [], steps: [],
  }
}
beforeEach(() => removeChatRuns())

describe('durable chat storage', () => {
  it('preserves concurrent host updates and panel tool results', async () => {
    await updateChatRun('chat', () => run())
    await Promise.all([
      updateChatRun('chat', old => ({ ...old!, parts: [{ type: 'text', text: 'Streaming' }] })),
      updateChatRun('chat', old => ({ ...old!, toolRequests: [{ id: 'tool', name: 'ToolSearch', input: {}, state: 'done', output: { found: true } }] })),
      updateChatRun('chat', old => ({ ...old!, ownerUntil: 999 })),
    ])
    const saved = await getChatRun('chat')
    expect(saved?.parts).toEqual([{ type: 'text', text: 'Streaming' }])
    expect(saved?.toolRequests[0].output).toEqual({ found: true })
    expect(saved?.ownerUntil).toBe(999)
  })

  it('rejects a second active run atomically', async () => {
    const create = () => updateChatRun('chat', old => {
      if (activeChatRun(old)) throw new Error('Already running')
      return run()
    })
    const outcomes = await Promise.allSettled([create(), create()])
    expect(outcomes.map(o => o.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((await listChatRuns()).length).toBe(1)
  })

  it('does not resurrect a deleted run when a late host write arrives', async () => {
    await updateChatRun('chat', () => run())
    await saveConversation({ id: 'chat', messages: [], history: [] })
    await deleteConversation('chat')
    await updateChatRun('chat', old => old?.id === 'run' ? { ...old, state: 'done' } : old)
    expect(await getChatRun('chat')).toBeUndefined()
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

  it('keeps partial text and shows a generation error on restoration', () => {
    const job = run()
    job.parts = [{ type: 'text', text: 'Partial reply' }]
    job.error = 'Host interrupted'
    expect(chatRunMessages(job).at(-1)?.parts).toEqual([
      { type: 'text', text: 'Partial reply' }, { type: 'text', text: '**Error:** Host interrupted' },
    ])
  })
})


it('publishes only committed changes and advances reply versions only for changed parts', async () => {
  const events: string[] = []
  const unsubscribe = chatRunChanges.subscribe(id => events.push(id))
  try {
    const created = await updateChatRun('chat', () => run())
    await updateChatRun('chat', old => old)
    const heartbeat = await updateChatRun('chat', old => ({ ...old!, ownerUntil: 1234 }))
    expect(heartbeat?.partsVersion).toBe(created?.partsVersion)
    const reply = await updateChatRun('chat', old => ({ ...old!, parts: [{ type: 'text', text: 'New' }] }))
    expect(reply?.partsVersion).toBe(created!.partsVersion! + 1)
    await expect(updateChatRun('chat', () => { throw new Error('abort') })).rejects.toThrow('abort')
    expect(events).toEqual(['chat', 'chat', 'chat'])
    expect((await getChatRun('chat'))?.parts).toEqual(reply?.parts)
  } finally { unsubscribe() }
})
