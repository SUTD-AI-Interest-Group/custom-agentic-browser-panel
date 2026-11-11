// Offscreen chat actor. Inference survives panel closure; browser operations
// are delegated to the worker; approval requests persist independently of UI.
import { changeMailbox } from '../data/changeSignal'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import type { JSONSchema7 } from '@ai-sdk/provider'
import { runAgentTurn, type UIPart } from '../agent/agent'
import { createModel } from '../agent/provider'
import type { Trace } from '../agent/observability/types'
import type { ProviderConfig } from '../data/settings'
import { openSecret } from '../data/vault'
import { chatRunChanges, chatRunMessages, getChatRun, updateChatRun, type ChatRun } from '../data/chatRuns'
import { saveConversation } from '../data/conversations'
import { dehydrateHistory } from '../data/attachmentRefs'
import { saveTrace } from '../data/traces'

const running = new Map<string, AbortController>()
export const hasChatWork = () => running.size > 0
const send = (message: unknown) => { void chrome.runtime.sendMessage(message).catch(() => {}) }

export function installChatHost(onIdle: () => void) {
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type === 'chat.hasRun') {
      respond({ active: running.has(msg.id) })
    } else if (msg?.type === 'chat.execute') {
      void executeChat(msg.conversationId, msg.id).finally(onIdle).catch(console.error)
      respond({ ok: true, id: msg.id })
    } else if (msg?.type === 'chat.abort') {
      running.get(msg.id)?.abort()
    }
  })
}

async function executeChat(conversationId: string, id: string) {
  if (running.has(id)) return
  const controller = new AbortController()
  running.set(id, controller)
  let job: ChatRun | undefined
  let keepSession = false
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let latestParts: UIPart[] = []
  let writes = Promise.resolve()
  let polling: ReturnType<typeof setInterval> | undefined
  const update = (change: (old: ChatRun) => ChatRun) => updateChatRun(conversationId, (old) => old?.id === id ? change(old) : old)
  const flush = () => {
    const parts = latestParts
    writes = writes.then(async () => { await update((old) => ({ ...old, parts, updatedAt: Date.now() })) })
    return writes
  }
  try {
    job = await getChatRun(conversationId)
    if (!job || job.id !== id || job.state !== 'queued') return
    const config = JSON.parse(await openSecret(job.providerSealed ?? '') ?? '') as ProviderConfig
    await update((old) => ({ ...old, state: 'running', providerSealed: undefined, updatedAt: Date.now() }))
    const images = job.images.slice(), activeNames = job.activeNames ? new Set(job.activeNames) : undefined
    let parked = false
    // Refresh cheap live context and detect deletion/Stop even during a long
    // silent reasoning phase. Never use the worker's lifetime as the job clock.
    let lastToolHealthCheck = 0
    let refreshing = false
    polling = setInterval(() => {
      if (refreshing) return
      refreshing = true
      if (Date.now() - lastToolHealthCheck > 20_000) {
        lastToolHealthCheck = Date.now()
        send({ type: 'chat.tools.status', id, conversationId })
      }
      void getChatRun(conversationId).then(async (current) => {
        if (!current || current.id !== id || current.cancelRequested) { controller.abort(); return }
        job = current
        if (Date.now() - current.updatedAt >= 2000) await update((old) => ({ ...old, updatedAt: Date.now() }))
      }).catch(() => controller.abort()).finally(() => { refreshing = false })
    }, 1000)
    const tools: ToolSet = {}
    for (const tool of job.tools) tools[tool.name] = dynamicTool({
      description: tool.description,
      inputSchema: jsonSchema(tool.inputSchema as JSONSchema7),
      execute: async (input, { toolCallId }) => {
        const changes = changeMailbox(chatRunChanges, conversationId)
        try {
        await update((old) => ({ ...old, toolRequests: [...old.toolRequests, { id: toolCallId, name: tool.name, input, state: 'requested' }] }))
        let polledAt = 0
        while (true) {
          if (Date.now() - polledAt > 1000) {
            polledAt = Date.now()
            await chrome.runtime.sendMessage({ type: 'chat.tool.poll', conversationId, id, requestId: toolCallId })
          }
          controller.signal.throwIfAborted()
          const current = await getChatRun(conversationId)
          if (!current || current.id !== id) throw new Error('Conversation was removed.')
          const request = current.toolRequests.find((r) => r.id === toolCallId)
          if (request?.state === 'done') {
            images.push(...request.images ?? [])
            if (activeNames) for (const name of request.activeNames ?? []) activeNames.add(name)
            if (request.parked) parked = true
            if (request.error) throw new Error(request.error)
            return request.output
          }
          await changes.wait(1000)
        }
        } finally { changes.close() }
      },
    })
    const traceMessage = (event: unknown) => send({ type: 'chat.trace', id, event })
    const trace: Trace = {
      id, generation: (options) => ({ id: crypto.randomUUID(), end: (end) => traceMessage({ kind: 'generation', options, end }) }),
      update: (options) => traceMessage({ kind: 'update', options }),
      span: () => ({ id: '', end() {} }), event() {}, end() {},
    }
    const result = await runAgentTurn({
      model: createModel(config, job.modelId), system: job.system, history: job.history,
      tools, abortSignal: controller.signal, imageQueue: images, activeNames,
      steerPending: () => job?.steerPending ?? false,
      parkPending: () => parked || (job?.parkPending ?? false),
      agentState: job.agentState ? () => job!.agentState! : undefined,
      trace,
      sink: job.traceEnabled ? { step: (step) => { writes = writes.then(async () => { await update((old) => ({ ...old, steps: [...old.steps, step] })) }) } } : undefined,
      onUpdate: (parts) => {
        latestParts = parts
        if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = undefined; void flush().catch(() => controller.abort()) }, 200)
      },
    })
    keepSession = result.stop.reason !== 'completed' && job.ownerUntil > Date.now()
    if (flushTimer) clearTimeout(flushTimer)
    latestParts = result.parts
    await flush()
    const done = await update((old) => ({ ...old, result, activeNames: activeNames ? [...activeNames] : undefined, updatedAt: Date.now() }))
    if (!done || done.id !== id) return
    let messages = chatRunMessages(done)
    if (done.steps.length) {
      const saved = await saveTrace({ id: done.assistantId, conversationId, createdAt: Date.now(), label: 'Background chat', steps: done.steps }).then(() => true, () => false)
      if (saved) messages = messages.map(m => m.id === done.assistantId ? { ...m, hasTrace: true } : m)
    }
    await saveConversation({ id: conversationId, completedMcpTask: done.completedMcpTask, messages, history: dehydrateHistory([...done.history, ...result.responseMessages]) })
    await update((old) => ({ ...old, state: 'done', providerSealed: undefined }))
    send({ type: 'chat.settled', conversationId, id })
  } catch (error) {
    keepSession = false
    if (flushTimer) clearTimeout(flushTimer)
    await writes.catch(() => {})
    const errorText = error instanceof Error ? error.message : String(error)
    const failed = await update((old) => ({ ...old, parts: latestParts, error: controller.signal.aborted ? undefined : errorText, providerSealed: undefined, updatedAt: Date.now() }))
    if (failed?.id === id) {
      await saveConversation({ id: conversationId, messages: chatRunMessages(failed), history: dehydrateHistory(failed.history) }).catch(() => {})
      await update((old) => ({ ...old, state: controller.signal.aborted ? 'cancelled' : 'error' }))
      send({ type: 'chat.settled', conversationId, id })
    }
  } finally {
    if (polling) clearInterval(polling)
    if (flushTimer) clearTimeout(flushTimer)
    send({ type: 'chat.tools.release', id, conversationId, chainId: job?.chainId ?? id, keepSession })
    running.delete(id)
  }
}
