import { durableDatabase } from './durableDatabase'
import { createChangeSignal } from './changeSignal'
import type { ApprovalRequest } from '../tools/tools'
import { sumUsage } from '../agent/usage'
import type { ModelMessage } from 'ai'
import type { AgentSystemPrompt, AgentTurnResult, QueuedImage, UIMessage, UIPart } from '../agent/agent'
import type { AgentStateFacts } from '../agent/agentState'
import type { TraceStep } from './traces'

export interface ChatToolRequest {
  id: string
  name: string
  input: unknown
  state: 'requested' | 'executing' | 'done'
  output?: unknown
  error?: string
  images?: QueuedImage[]
  activeNames?: string[]
  parked?: boolean
}
export interface ChatRun {
  id: string
  conversationId: string
  chainId?: string
  owner: string
  ownerUntil: number
  windowId?: number
  tabId?: number
  completedMcpTask?: string
  assistantId: string
  providerSealed?: string
  providerId?: string
  visionCapable?: boolean
  allowedTools?: string[]
  approvals?: { id: string; request: ApprovalRequest; decision?: boolean }[]
  modelId: string
  system: AgentSystemPrompt
  history: ModelMessage[]
  messages: UIMessage[]
  baseParts: UIPart[]
  tools: { name: string; description?: string; inputSchema: unknown }[]
  activeNames?: string[]
  images: QueuedImage[]
  agentState?: Omit<AgentStateFacts, 'step' | 'maxSteps'>
  steerPending?: boolean
  parkPending?: boolean
  parts: UIPart[]
  /** Changes only when reply parts change, not on lease/approval heartbeats. */
  partsVersion?: number
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  updatedAt: number
  toolRequests: ChatToolRequest[]
  traceEnabled?: boolean
  steps: TraceStep[]
  result?: AgentTurnResult
  error?: string
  cancelRequested?: boolean
  /** Offscreen generation outlived its owning panel and needs a user action. */
  needsPanel?: boolean
}
export const activeChatRun = (r: ChatRun | undefined | null): r is ChatRun & { state: 'queued' | 'running' } => !!r && (r.state === 'queued' || r.state === 'running')
const transaction = durableDatabase('lychee-chat-runs', 'runs', 'conversationId')
export const chatRunChanges = createChangeSignal('lychee-chat-runs')
export async function getChatRun(chat: string): Promise<ChatRun | undefined> {
  const tx = await transaction()
  return new Promise((resolve, reject) => {
    const req = tx.objectStore('runs').get(chat)
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error)
    tx.onabort = () => reject(tx.error)
  })
}
export async function listChatRuns(): Promise<ChatRun[]> {
  const tx = await transaction()
  return new Promise((resolve, reject) => {
    const req = tx.objectStore('runs').getAll()
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error)
    tx.onabort = () => reject(tx.error)
  })
}
export async function updateChatRun(chat: string, change: (old: ChatRun | undefined) => ChatRun | undefined): Promise<ChatRun | undefined> {
  const tx = await transaction('readwrite')
  return new Promise((resolve, reject) => {
    const store = tx.objectStore('runs')
    const req = store.get(chat)
    let result: ChatRun | undefined, failure: unknown, changed = false
    req.onsuccess = () => {
      try {
        const old = req.result as ChatRun | undefined
        result = change(old)
        changed = result !== old
        if (!changed) return
        if (result) {
          result = { ...result, partsVersion: result.parts !== old?.parts ? (old?.partsVersion ?? 0) + 1 : old?.partsVersion }
          store.put(result)
        } else store.delete(chat)
      }
      catch (error) { failure = error; tx.abort() }
    }
    tx.oncomplete = () => { if (changed) chatRunChanges.publish(chat); resolve(result) }
    tx.onerror = tx.onabort = () => reject(failure ?? tx.error)
  })
}
export function chatRunMessages(run: ChatRun): UIMessage[] {
  const parts = [...run.baseParts, ...run.parts]
  if (run.error) parts.push({ type: 'text', text: `**Error:** ${run.error}` })
  const bubble: UIMessage = { id: run.assistantId, role: 'assistant', parts, usage: sumUsage(run.messages.find(m => m.id === run.assistantId)?.usage, run.result?.usage) }
  return run.messages.some((m) => m.id === run.assistantId)
    ? run.messages.map((m) => m.id === run.assistantId ? { ...m, ...bubble } : m)
    : [...run.messages, bubble]
}
export async function removeChatRuns(chat?: string) {
  for (const run of await listChatRuns()) if (!chat || run.conversationId === chat) await updateChatRun(run.conversationId, () => undefined)
}
