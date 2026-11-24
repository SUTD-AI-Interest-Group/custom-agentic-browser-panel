import { durableDatabase } from './durableDatabase'
import { createChangeSignal } from './changeSignal'
import type { ApprovalRequest } from '../tools/tools'
import { sumUsage } from '../agent/usage'
import type { ModelMessage } from 'ai'
import type { AgentSystemPrompt, AgentTurnResult, QueuedImage, UIMessage, UIPart } from '../agent/agent'
import type { AgentStateFacts } from '../agent/agentState'
import type { TraceStep } from './traces'
import type { DriverSpec } from '../decider/driverPrompt'

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

/**
 * Everything a durable run is started WITH. Written once, in the transaction that creates the
 * run, and never again: the whole conversation's model history and transcript, every tool schema
 * and the queued images are by far the largest part of a run, and they used to be rewritten — and
 * re-read by every watcher — on each 200 ms reply flush. Immutable per run id, so a reader that
 * polls can cache it (createChatRunReader).
 */
export interface ChatRunSpec {
  id: string
  conversationId: string
  chainId?: string
  windowId?: number
  tabId?: number
  completedMcpTask?: string
  assistantId: string
  providerId?: string
  visionCapable?: boolean
  modelId: string
  system: AgentSystemPrompt
  history: ModelMessage[]
  messages: UIMessage[]
  baseParts: UIPart[]
  tools: { name: string; description?: string; inputSchema: unknown }[]
  images: QueuedImage[]
  traceEnabled?: boolean
  /**
   * A `@driver` run: the offscreen host runs the scripted model (src/agent/driverScript.ts) instead
   * of the chat model, and the worker's tool host builds this run's ToolSet in Driver mode (Mode Off
   * still off — config.ts withDriverOverride). Only the parse of the user's own message, which this
   * record's `history` already holds; it grants nothing.
   */
  driver?: DriverSpec
}

/** Everything that changes while a run is in flight: the only half any update writes. */
export interface ChatRunLive {
  id: string
  conversationId: string
  owner: string
  ownerUntil: number
  providerSealed?: string
  allowedTools?: string[]
  approvals?: { id: string; request: ApprovalRequest; decision?: boolean }[]
  /** The tools loaded so far: seeded at creation, final once the run is done. */
  activeNames?: string[]
  agentState?: Omit<AgentStateFacts, 'step' | 'maxSteps'>
  steerPending?: boolean
  parkPending?: boolean
  parts: UIPart[]
  /** Changes only when reply parts change, not on lease/approval heartbeats. */
  partsVersion?: number
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  updatedAt: number
  toolRequests: ChatToolRequest[]
  steps: TraceStep[]
  result?: AgentTurnResult
  error?: string
  cancelRequested?: boolean
  /** Offscreen generation outlived its owning panel and needs a user action. */
  needsPanel?: boolean
}

export type ChatRun = ChatRunSpec & ChatRunLive

// Every field is on exactly one side (id and conversationId on both, as keys and identity). A new
// field fails to compile until it is listed: left out, it would silently never be stored.
const SPEC_KEYS = [
  'id', 'conversationId', 'chainId', 'windowId', 'tabId', 'completedMcpTask', 'assistantId', 'providerId',
  'visionCapable', 'modelId', 'system', 'history', 'messages', 'baseParts', 'tools', 'images', 'traceEnabled', 'driver',
] as const satisfies readonly (keyof ChatRunSpec)[]
const LIVE_KEYS = [
  'id', 'conversationId', 'owner', 'ownerUntil', 'providerSealed', 'allowedTools', 'approvals', 'activeNames',
  'agentState', 'steerPending', 'parkPending', 'parts', 'partsVersion', 'state', 'updatedAt', 'toolRequests', 'steps',
  'result', 'error', 'cancelRequested', 'needsPanel',
] as const satisfies readonly (keyof ChatRunLive)[]
type Unlisted<T, K extends PropertyKey> = Exclude<keyof T, K>
const specKeysComplete: Unlisted<ChatRunSpec, (typeof SPEC_KEYS)[number]> extends never ? true : never = true
const liveKeysComplete: Unlisted<ChatRunLive, (typeof LIVE_KEYS)[number]> extends never ? true : never = true
void specKeysComplete; void liveKeysComplete

function pick<T>(value: object, keys: readonly string[]): T {
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
  return out as T
}
export const chatRunSpec = (run: ChatRun): ChatRunSpec => pick(run, SPEC_KEYS)
const liveOf = (value: ChatRunLive): ChatRunLive => pick(value, LIVE_KEYS)
const merge = (spec: ChatRunSpec | undefined, live: ChatRunLive | undefined): ChatRun | undefined =>
  spec && live && spec.id === live.id ? { ...spec, ...live } : undefined

export const activeChatRun = (r: ChatRunLive | undefined | null): r is ChatRunLive & { state: 'queued' | 'running' } => !!r && (r.state === 'queued' || r.state === 'running')

// `runs` predates the split and keeps its name — IndexedDB cannot rename a store — but now holds
// only the spec. A run's two halves are created and deleted in ONE transaction, the same rule as
// conversations.ts's summaries store: a reader can never see one half without the other.
const SPEC_STORE = 'runs'
const LIVE_STORE = 'live'
const transaction = durableDatabase('lychee-chat-runs', { [SPEC_STORE]: 'conversationId', [LIVE_STORE]: 'conversationId' }, splitLegacyRuns)
export const chatRunChanges = createChangeSignal('lychee-chat-runs')

/** Builds before the split kept the whole run in `runs`. Split each record in the same upgrade that
 *  creates the live store, so no reader ever finds a spec without its live half. */
function splitLegacyRuns(upgrade: IDBTransaction, created: string[]) {
  if (!created.includes(LIVE_STORE) || created.includes(SPEC_STORE)) return
  const live = upgrade.objectStore(LIVE_STORE)
  const cursor = upgrade.objectStore(SPEC_STORE).openCursor()
  cursor.onsuccess = () => {
    const at = cursor.result
    if (!at) return
    const run = at.value as ChatRun
    live.put(liveOf(run))
    at.update(chatRunSpec(run))
    at.continue()
  }
}

const settle = <T>(tx: IDBTransaction, read: () => T) => new Promise<T>((resolve, reject) => {
  tx.oncomplete = () => resolve(read())
  tx.onerror = tx.onabort = () => reject(tx.error)
})

/** The half a hot loop needs: state, reply parts, approvals, tool requests, the lease. */
export async function getChatRunLive(chat: string): Promise<ChatRunLive | undefined> {
  const tx = await transaction('readonly', LIVE_STORE)
  const req = tx.objectStore(LIVE_STORE).get(chat)
  return settle(tx, () => req.result as ChatRunLive | undefined)
}
/** The whole run, both halves from one snapshot. For one-off reads; a loop uses createChatRunReader. */
export async function getChatRun(chat: string): Promise<ChatRun | undefined> {
  const tx = await transaction()
  const spec = tx.objectStore(SPEC_STORE).get(chat), live = tx.objectStore(LIVE_STORE).get(chat)
  return settle(tx, () => merge(spec.result, live.result))
}
export async function listChatRuns(): Promise<ChatRun[]> {
  const tx = await transaction()
  const specs = tx.objectStore(SPEC_STORE).getAll(), lives = tx.objectStore(LIVE_STORE).getAll()
  return settle(tx, () => {
    const live = new Map((lives.result as ChatRunLive[]).map((l) => [l.conversationId, l]))
    return (specs.result as ChatRunSpec[]).flatMap((spec) => merge(spec, live.get(spec.conversationId)) ?? [])
  })
}

/**
 * A whole-run reader for code that re-reads a run often (a watcher redrawing the transcript, the
 * tool host on every tool poll). A run's spec never changes after it is created, so it is read once
 * per run id and every later call reads only the live half.
 */
export function createChatRunReader(): (chat: string) => Promise<ChatRun | undefined> {
  const specs = new Map<string, ChatRunSpec>()
  return async (chat) => {
    const live = await getChatRunLive(chat)
    if (!live) return undefined
    const spec = specs.get(chat)
    if (spec?.id === live.id) return { ...spec, ...live }
    const full = await getChatRun(chat)
    specs.delete(chat)
    if (full) {
      specs.set(chat, chatRunSpec(full))
      // One cached spec per conversation, and only a few conversations: specs are large.
      if (specs.size > 4) specs.delete(specs.keys().next().value!)
    }
    return full
  }
}

/** Creates a run, atomically refusing while the conversation already has one in flight. */
export async function createChatRun(run: ChatRun): Promise<ChatRun> {
  const tx = await transaction('readwrite')
  const lives = tx.objectStore(LIVE_STORE)
  const req = lives.get(run.conversationId)
  let failure: unknown, created = run
  req.onsuccess = () => {
    const old = req.result as ChatRunLive | undefined
    if (activeChatRun(old)) {
      failure = new Error('This conversation is already generating in the background.')
      tx.abort()
      return
    }
    created = { ...run, partsVersion: (old?.partsVersion ?? 0) + 1 }
    tx.objectStore(SPEC_STORE).put(chatRunSpec(created))
    lives.put(liveOf(created))
  }
  try {
    await settle(tx, () => undefined)
  } catch (error) {
    throw failure ?? error
  }
  chatRunChanges.publish(run.conversationId)
  return created
}

/**
 * Updates the live half of an existing run; a missing run is left missing (a late write never
 * resurrects a deleted one). Only live fields are ever stored, whatever `change` returns — a whole
 * run passed back is reduced to its live half rather than bloating the record every flush rewrites.
 */
export async function updateChatRun(chat: string, change: (old: ChatRunLive) => ChatRunLive): Promise<ChatRunLive | undefined> {
  const tx = await transaction('readwrite', LIVE_STORE)
  return new Promise((resolve, reject) => {
    const store = tx.objectStore(LIVE_STORE)
    const req = store.get(chat)
    let result: ChatRunLive | undefined, failure: unknown, changed = false
    req.onsuccess = () => {
      try {
        const old = req.result as ChatRunLive | undefined
        result = old
        if (!old) return
        const next = change(old)
        if (next === old) return
        changed = true
        result = liveOf({ ...next, partsVersion: next.parts !== old.parts ? (old.partsVersion ?? 0) + 1 : old.partsVersion })
        store.put(result)
      }
      catch (error) { failure = error; tx.abort() }
    }
    tx.oncomplete = () => { if (changed) chatRunChanges.publish(chat); resolve(result) }
    tx.onerror = tx.onabort = () => reject(failure ?? tx.error)
  })
}

/**
 * A finished tool request once the offscreen host has taken its result. A request is only the
 * hand-off from the worker that runs the tool to the host that waits on it; once taken, the result
 * lives on in the reply parts (what the panel draws and the transcript saves) and in the model's
 * own messages. Left in place it was a second full copy of every tool output and screenshot of the
 * turn, rewritten with the live half on every 200 ms flush. What remains — id, name, `done` — is
 * what stops the worker ever running it again. Returns `live` itself when there is nothing to drop,
 * so the update writes nothing.
 */
export function consumeToolRequest(live: ChatRunLive, requestId: string): ChatRunLive {
  const request = live.toolRequests.find((r) => r.id === requestId)
  if (!request || request.state !== 'done') return live
  const alreadyBare = Object.entries(request).every(([key, value]) => key === 'id' || key === 'name' || key === 'state' || value === undefined)
  if (alreadyBare) return live
  const consumed: ChatToolRequest = { id: request.id, name: request.name, input: undefined, state: 'done' }
  return { ...live, toolRequests: live.toolRequests.map((r) => (r.id === requestId ? consumed : r)) }
}

export function chatRunMessages(run: ChatRun): UIMessage[] {
  const parts = [...run.baseParts, ...run.parts]
  if (run.error) parts.push({ type: 'text', text: `**Error:** ${run.error}` })
  const prior = run.messages.find(m => m.id === run.assistantId)?.usage
  // A `@driver` run's scripted model reports zero usage — no chat-model tokens were spent — so it
  // adds none (the panel attaches none either: a "0 → 0" chip reads as a bug), and its bubble keeps
  // the driver mark even when no panel was open to set it.
  const bubble: UIMessage = run.driver
    ? { id: run.assistantId, role: 'assistant', parts, usage: prior, driver: true }
    : { id: run.assistantId, role: 'assistant', parts, usage: sumUsage(prior, run.result?.usage) }
  return run.messages.some((m) => m.id === run.assistantId)
    ? run.messages.map((m) => m.id === run.assistantId ? { ...m, ...bubble } : m)
    : [...run.messages, bubble]
}

/** Deletes one conversation's run (both halves), or every run. */
export async function removeChatRuns(chat?: string) {
  const tx = await transaction('readwrite')
  const lives = tx.objectStore(LIVE_STORE), specs = tx.objectStore(SPEC_STORE)
  const keys = chat === undefined ? lives.getAllKeys() : lives.getKey(chat)
  if (chat === undefined) { lives.clear(); specs.clear() }
  else { lives.delete(chat); specs.delete(chat) }
  const removed = await settle(tx, () => [keys.result].flat().filter((k): k is string => typeof k === 'string'))
  for (const id of removed) chatRunChanges.publish(id)
}
