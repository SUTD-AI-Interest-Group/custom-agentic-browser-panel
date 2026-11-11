import { durableDatabase } from './durableDatabase'
import type { CallToolResult, Task } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerEntry } from '../mcp/config'

export interface StoredMcpTask {
  id: string
  conversationId: string
  server: string
  tool: string
  configHash: string
  sessionId?: string
  protocolVersion?: string
  cancelSupported?: boolean
  task: Task
  args: Record<string, unknown>
  createdAt: number
  nextPollAt: number
  result?: CallToolResult
  error?: string
  /** Only final outcomes enter the durable completion inbox. */
  ready?: boolean
  delivered?: boolean
  /** Stop suppresses future automatic continuation, not remote execution. */
  suppressed?: boolean
  lease?: { owner: string; until: number }
}

export const MCP_TASK_CHANGED = 'mcp-task.changed'
export const mcpTaskKey = (chat: string, server: string, tool: string, task: string) => JSON.stringify([chat, server, tool, task])
export const terminalTask = (task: Task) => ['completed', 'failed', 'cancelled'].includes(task.status)

/** Bind to the full configuration without copying credentials into the task store. */
export async function mcpConfigHash(entry: McpServerEntry): Promise<string> {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
    )
    return value
  }
  const text = JSON.stringify(canonical(entry))
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

const transaction = durableDatabase('lychee-mcp-tasks', 'tasks', 'id')

function changed() {
  try { void chrome.runtime.sendMessage({ type: MCP_TASK_CHANGED }).catch(() => {}) } catch { /* closing context */ }
}

export async function listMcpTasks(): Promise<StoredMcpTask[]> {
  const tx = await transaction()
  return new Promise((resolve, reject) => {
    const req = tx.objectStore('tasks').getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function getMcpTask(id: string): Promise<StoredMcpTask | undefined> {
  const tx = await transaction()
  return new Promise((resolve, reject) => {
    const req = tx.objectStore('tasks').get(id)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    tx.onabort = () => reject(tx.error)
  })
}

/** Read/modify/write in one IDB transaction: panel and worker cannot overwrite each other's fields. */
export async function updateMcpTask(id: string, update: (old: StoredMcpTask | undefined) => StoredMcpTask | undefined): Promise<StoredMcpTask | undefined> {
  const tx = await transaction('readwrite')
  return new Promise((resolve, reject) => {
    const store = tx.objectStore('tasks')
    let result: StoredMcpTask | undefined
    let mutated = false
    let failure: unknown
    const req = store.get(id)
    req.onsuccess = () => {
      try {
        result = update(req.result)
        mutated = result !== req.result
        if (mutated) {
          if (result) store.put(result)
          else store.delete(id)
        }
      } catch (error) { failure = error; tx.abort() }
    }

    tx.oncomplete = () => { if (mutated) changed(); resolve(result) }
    tx.onerror = () => reject(failure ?? tx.error)
    tx.onabort = () => reject(failure ?? tx.error)
  })
}

export async function deleteMcpTasks(conversationId?: string) {
  for (const task of await listMcpTasks()) {
    if (!conversationId || task.conversationId === conversationId) await updateMcpTask(task.id, () => undefined)
  }
}

export async function claimMcpCompletion(id: string, owner: string): Promise<StoredMcpTask | undefined> {
  let claimed = false
  const record = await updateMcpTask(id, (old) => {
    if (!old?.ready || old.delivered || old.suppressed || (old.lease && old.lease.until > Date.now())) return old
    claimed = true
    return { ...old, lease: { owner, until: Date.now() + 60_000 } }
  })
  return claimed ? record : undefined
}
