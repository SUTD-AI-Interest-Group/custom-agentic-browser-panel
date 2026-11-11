import { changeMailbox } from '../data/changeSignal'
import { startChatRun } from './chatStartup'
import type { ApprovalGate } from '../tools/tools'
// Panel-side adapter: the offscreen document owns inference, this context owns
// approval UI. Closing the panel only detaches this observer.
import { asSchema } from 'ai'
import type { runAgentTurn } from './agent'
import type { ProviderConfig } from '../data/settings'
import { sealSecret } from '../data/vault'
import { activeChatRun, chatRunChanges, getChatRun, updateChatRun, type ChatRun } from '../data/chatRuns'

export const CHAT_OWNER = crypto.randomUUID()
type Options = Parameters<typeof runAgentTurn>[0]
export async function runDurableChat(options: Options, context: {
  chainId: string
  requestApproval: ApprovalGate; allowedTools: () => string[]; visionCapable: boolean
  completedMcpTask?: string
  conversationId: string; assistantId: string; provider: ProviderConfig; modelId: string
  messages: ChatRun['messages']; baseParts: ChatRun['baseParts']; tabId?: number
}): ReturnType<typeof runAgentTurn> {
  const id = crypto.randomUUID()
  const windowId = (await chrome.windows.getCurrent()).id
  const tools = await Promise.all(Object.entries(options.tools).filter(([, t]) => !!t).map(async ([name, tool]) => ({
    name, description: typeof tool.description === 'function' ? tool.description({ context: undefined }) : tool.description,
    inputSchema: await asSchema(tool.inputSchema).jsonSchema,
  })))
  const providerSealed = await sealSecret(JSON.stringify(context.provider))
  options.abortSignal.throwIfAborted()
  await updateChatRun(context.conversationId, (old) => {
    if (activeChatRun(old)) throw new Error('This conversation is already generating in the background.')
    return {
      id, chainId: context.chainId, conversationId: context.conversationId, owner: CHAT_OWNER, ownerUntil: Date.now() + 5000,
      completedMcpTask: context.completedMcpTask, windowId, tabId: context.tabId, assistantId: context.assistantId, providerSealed,
      providerId: context.provider.id, visionCapable: context.visionCapable, allowedTools: context.allowedTools(), approvals: [],
      modelId: context.modelId, system: options.system, history: options.history,
      messages: context.messages, baseParts: context.baseParts, tools,
      images: options.imageQueue?.splice(0) ?? [], activeNames: options.activeNames ? [...options.activeNames] : undefined,
      agentState: options.agentState?.(), parts: [], state: 'queued', updatedAt: Date.now(), toolRequests: [], traceEnabled: !!options.sink, steps: [],
    }
  })
  const abort = () => { void chrome.runtime.sendMessage({ type: 'chat.abort', conversationId: context.conversationId, id }).catch(() => {}) }
  const detach = () => { void updateChatRun(context.conversationId, (old) => old?.id === id ? { ...old, ownerUntil: 0 } : old).catch(() => {}) }
  options.abortSignal.addEventListener('abort', abort, { once: true })
  window.addEventListener('pagehide', detach)
  const onTrace = (msg: { type?: string; id?: string; event?: any }) => {
    if (msg.type !== 'chat.trace' || msg.id !== id || !options.trace) return
    const event = msg.event
    if (event?.kind === 'generation') options.trace.generation(event.options).end(event.end)
    if (event?.kind === 'update') options.trace.update(event.options)
  }
  chrome.runtime.onMessage.addListener(onTrace)
  const executing = new Set<string>()
  let lastParts: number | undefined, steps = 0, heartbeat = 0
  const changes = changeMailbox(chatRunChanges, context.conversationId)
  try {
    await startChatRun(context.conversationId, id)
    if (options.abortSignal.aborted) abort()
    while (true) {
      const run = await getChatRun(context.conversationId)
      if (!run || run.id !== id) throw new Error('Background chat was removed or replaced.')
      const signature = run.partsVersion ?? 0
      if (signature !== lastParts) { lastParts = signature; options.onUpdate(run.parts) }
      for (; steps < run.steps.length; steps++) options.sink?.step(run.steps[steps])
      if (run.state === 'error') throw new Error(run.error ?? 'Background generation failed.')
      if (run.state === 'cancelled') throw new DOMException('Generation stopped.', 'AbortError')
      if (run.state === 'done' && run.result) {
        options.abortSignal.throwIfAborted()
        if (run.activeNames && options.activeNames) for (const name of run.activeNames) options.activeNames.add(name)
        return run.result
      }
      if (Date.now() - heartbeat > 1000) {
        heartbeat = Date.now()
        void chrome.runtime.sendMessage({ type: 'chat.inspect', conversationId: context.conversationId }).catch(() => {})
        await updateChatRun(context.conversationId, (old) => old?.id === id ? {
          ...old, ownerUntil: Date.now() + 5000, allowedTools: [...new Set([...old.allowedTools ?? [], ...context.allowedTools()])], agentState: options.agentState?.(),
          steerPending: options.steerPending?.(), parkPending: options.parkPending?.(),
        } : old)
      }
      for (const approval of run.approvals ?? []) {
        if (approval.decision !== undefined || executing.has(approval.id) || options.abortSignal.aborted) continue
        executing.add(approval.id)
        void context.requestApproval(approval.request).then(async decision => {
          await chrome.runtime.sendMessage({ type: 'chat.approval.decide', conversationId: context.conversationId, id, approvalId: approval.id, decision, allowedTools: context.allowedTools() })
        }).catch(console.error)
      }
      await changes.wait(1000)
    }
  } catch (error) {
    await updateChatRun(context.conversationId, old => old?.id === id && old.state === 'queued'
      ? { ...old, state: 'error', providerSealed: undefined, error: error instanceof Error ? error.message : String(error) } : old).catch(() => {})
    throw error
  } finally {
    changes.close()
    options.abortSignal.removeEventListener('abort', abort)
    window.removeEventListener('pagehide', detach)
    chrome.runtime.onMessage.removeListener(onTrace)
  }
}
