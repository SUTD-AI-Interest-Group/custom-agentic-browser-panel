import { installElicitationBridge } from './elicitationBridge'
import { changeMailbox } from '../data/changeSignal'
import { clearIndex } from '../platform/domIndex'
import { clearRegions } from '../platform/regionIndex'
// Tools run in the service worker for Chrome API access. The offscreen actor
// polls this host while a call is pending; approvals live in IDB, not a panel.
import { createAgentTools, type ApprovalRequest } from '../tools/tools'
import type { ControlSession } from '../tools/pageControl'
import { activeChatRun, chatRunChanges, getChatRun, updateChatRun, type ChatRun } from '../data/chatRuns'
import { loadSettings, toolPolicy } from '../data/settings'
import { grantedCapabilities } from '../platform/permissions'
import { splitPartnerOf } from '../platform/splitView'
import { getMcpManager } from '../mcp/manager'
import { buildMcpTools } from '../mcp/tools'
import type { QueuedImage } from '../agent/agent'
import type { ToolSet } from 'ai'
import { unmountPresence } from '../platform/presence'

const executing = new Map<string, AbortController>()
const sessions = new Map<string, ControlSession>()
const chains = new Map<string, string>()
const runChains = new Map<string, string>()
function endSession(chainId: string, conversationId: string) {
  const session = sessions.get(chainId)
  if (session) {
    // Only transient extension messaging carries undo values. They never enter
    // the durable job, transcript or trace, and vanish if no panel is listening.
    if (session.journal?.length) void chrome.runtime.sendMessage({ type: 'chat.control.journal', conversationId, tabId: session.tabId, entries: session.journal, undo: [...session.undoState ?? []] }).catch(() => {})
    session.active = false
    void clearIndex(session.tabId).catch(() => {}); void clearRegions(session.tabId).catch(() => {}); void unmountPresence(session.tabId).catch(() => {})
  }
  sessions.delete(chainId)
}
const toolsets = new Map<string, { key: string; tools: ToolSet; images: QueuedImage[]; names: Set<string>; parked: boolean }>()
function disconnectIfIdle() {
  if (!executing.size && !toolsets.size) getMcpManager().disconnectAll()
}

export function releaseChatTools(conversationId: string, id: string, keepSession = false) {
  for (const [key, controller] of executing) if (key.startsWith(`${id}:`)) controller.abort()
  if (!keepSession) {
    const chain = runChains.get(id)
    if (chain && chains.get(conversationId) === chain) {
      endSession(chain, conversationId)
      chains.delete(conversationId)
    }
  }
  runChains.delete(id)
  toolsets.delete(id)
  disconnectIfIdle()
}

/** A parked session belongs to its panel. Live background runs keep theirs. */
export async function releaseDetachedSessions(windowId: number) {
  for (const [conversationId, chainId] of chains) {
    const run = await getChatRun(conversationId)
    if ((!run || (run.windowId === windowId && !activeChatRun(run))) && chains.get(conversationId) === chainId) {
      endSession(chainId, conversationId)
      chains.delete(conversationId)
    }
  }
}

export function installToolHost() {
  installElicitationBridge()
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return
    if (msg?.type === 'chat.chain.release' && sender.url === chrome.runtime.getURL('sidepanel.html')) {
      if (chains.get(msg.conversationId) === msg.chainId) {
        endSession(msg.chainId, msg.conversationId)
        chains.delete(msg.conversationId)
      }
      reply({ ok: true })
      return
    }
    if (msg?.type === 'chat.approval.decide' && sender.url === chrome.runtime.getURL('sidepanel.html')) {
      void updateChatRun(msg.conversationId, old => old?.id === msg.id && activeChatRun(old) && typeof msg.decision === 'boolean' ? {
        ...old,
        allowedTools: [...new Set([...old.allowedTools ?? [], ...(Array.isArray(msg.allowedTools) ? msg.allowedTools.filter((n: unknown) => typeof n === 'string') : [])])],
        approvals: old.approvals?.map(a => a.id === msg.approvalId && a.decision === undefined ? { ...a, decision: msg.decision } : a),
      } : old).then(() => reply({ ok: true }), e => reply({ error: String(e) }))
      return true
    }
    if (sender.url !== chrome.runtime.getURL('offscreen.html')) return
    if (msg?.type === 'chat.tools.status') {
      reply({ sessionActive: sessions.get(chains.get(msg.conversationId) ?? msg.id)?.active ?? false, pending: [...executing.keys()].filter(k => k.startsWith(`${msg.id}:`)).length })
      return
    }
    if (msg?.type === 'chat.tool.poll') {
      void poll(msg.conversationId, msg.id, msg.requestId).then(() => reply({ ok: true }), e => reply({ error: String(e) }))
      return true
    }
    if (msg?.type === 'chat.tools.release') {
      releaseChatTools(msg.conversationId, msg.id, msg.keepSession === true)
      reply({ ok: true })
    }
  })
}
async function poll(conversationId: string, id: string, requestId: string) {
  const job = await getChatRun(conversationId)
  if (!job || job.id !== id) return
  const key = `${id}:${requestId}`, request = job.toolRequests.find(r => r.id === requestId)
  if (!activeChatRun(job) || job.cancelRequested) { executing.get(key)?.abort(); return }
  if (!request || request.state === 'done' || executing.has(key)) return
  if (request.state === 'executing') {
    // Worker eviction must never replay a mutation with an unknown outcome.
    await updateChatRun(conversationId, old => old?.id === id ? { ...old, toolRequests: old.toolRequests.map(r => r.id === requestId ? { ...r, state: 'done', error: 'Tool execution was interrupted. Its outcome is unknown; inspect the state before retrying.' } : r) } : old)
    return
  }
  const controller = new AbortController()
  executing.set(key, controller)
  void execute(job, requestId, controller.signal).finally(() => {
    executing.delete(key)
    disconnectIfIdle()
  }).catch(console.error)
}
async function execute(job: ChatRun, requestId: string, signal: AbortSignal) {
  const update = (fn: (old: ChatRun) => ChatRun) => updateChatRun(job.conversationId, old => old?.id === job.id ? fn(old) : old)
  const request = job.toolRequests.find(r => r.id === requestId)!
  const chainId = job.chainId ?? job.id
  const previous = chains.get(job.conversationId)
  if (previous && previous !== chainId) endSession(previous, job.conversationId)
  chains.set(job.conversationId, chainId)
  runChains.set(job.id, chainId)
  await update(old => ({ ...old, toolRequests: old.toolRequests.map(r => r.id === requestId ? { ...r, state: 'executing' } : r) }))
  let output: unknown, error: string | undefined, state: ReturnType<typeof toolsets.get>
  try {
    const settings = await loadSettings()
    const key = JSON.stringify(settings)
    state = toolsets.get(job.id)
    if (!state || state.key !== key) {
      const images: QueuedImage[] = [], names = new Set(job.activeNames)
      const runtime = { key, tools: {} as ToolSet, images, names, parked: false }
      const approve = async (request: ApprovalRequest): Promise<boolean> => {
        signal.throwIfAborted()
        const current = await getChatRun(job.conversationId)
        if (!current || current.id !== job.id || current.cancelRequested || !activeChatRun(current)) throw new DOMException('Stopped', 'AbortError')
        const policy = toolPolicy(await loadSettings(), request.toolName)
        if (policy === 'never') return false
        if (!request.once && !request.needsPermissions?.length && (policy === 'always' || current?.allowedTools?.includes(request.toolName))) return true
        const approvalId = crypto.randomUUID()
        await update(old => ({ ...old, approvals: [...old.approvals ?? [], { id: approvalId, request }] }))
        let notified = false
        const changes = changeMailbox(chatRunChanges, job.conversationId)
        try {
        while (true) {
          signal.throwIfAborted()
          const live = await getChatRun(job.conversationId)
          if (!live || live.id !== job.id || live.cancelRequested || !activeChatRun(live)) throw new DOMException('Stopped', 'AbortError')
          if (!notified && live.ownerUntil < Date.now()) {
            notified = true
            void Promise.resolve(chrome.notifications.create(`chat:${job.tabId ?? -1}`, {
              type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
              title: 'Lychee needs your approval', message: request.summary,
            })).catch(() => {})
          }
          const answer = live.approvals?.find(a => a.id === approvalId)?.decision
          if (answer !== undefined) return answer && toolPolicy(await loadSettings(), request.toolName) !== 'never'
          await changes.wait(1000)
        }
        } finally { changes.close() }
      }
      const provider = settings.providers.find(p => p.id === job.providerId)
      const manager = getMcpManager()
      await manager.refresh(settings)
      await manager.ready(signal)
      const mcp = buildMcpTools({ manager, settings, requestApproval: approve, imageQueue: images, conversationId: job.conversationId, visionCapable: job.visionCapable ?? false })
      runtime.tools = createAgentTools(approve, settings.tabAccess, await grantedCapabilities(), {
        session: () => sessions.get(chainId) ?? null,
        endSession: () => endSession(chainId, job.conversationId),
        requestSession: async ({ plan, host, origin, tabId }) => {
          const yes = await approve({ toolName: 'RequestPageControl', summary: `Control ${host}`, reason: plan, once: true })
          if (yes) sessions.set(chainId, { plan, origin, tabId, active: true })
          return yes
        },
      }, provider ? { provider, modelId: job.modelId } : null, job.visionCapable ?? false, images,
      name => toolPolicy(settings, name), job.conversationId, names, undefined, mcp, {
        resolveTab: async pane => {
          const tab = job.tabId === undefined ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] : await chrome.tabs.get(job.tabId).catch(() => undefined)
          return pane === 'partner' ? splitPartnerOf(tab) : tab
        },
        park: () => { runtime.parked = true },
      })
      signal.throwIfAborted()
      toolsets.set(job.id, runtime); state = runtime
    }
    const tool = state.tools[request.name]
    if (!tool?.execute) throw new Error(`Tool ${request.name} is disabled or unavailable.`)
    signal.throwIfAborted()
    const current = await getChatRun(job.conversationId)
    if (!current || current.id !== job.id || current.cancelRequested || !activeChatRun(current)) throw new DOMException('Stopped', 'AbortError')
    output = await tool.execute(request.input as never, { context: undefined, toolCallId: requestId, messages: job.history, abortSignal: signal })
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  await update(old => ({ ...old, toolRequests: old.toolRequests.map(r => r.id === requestId ? {
    ...r, state: 'done', output, error, images: state?.images.splice(0), activeNames: state ? [...state.names] : undefined, parked: state?.parked,
  } : r) }))
}
