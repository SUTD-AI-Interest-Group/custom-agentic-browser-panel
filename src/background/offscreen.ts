// Offscreen document: the headless research host. Only chrome.runtime messaging
// + Web APIs are available here — NO chrome.storage/tabs/notifications.
import type { ResearchMsg } from '../data/researchTasks'
import { runResearch } from '../agent/research'
import type { RenderBroker } from '../tools/research'

const running = new Map<string, AbortController>()

// Hybrid-escalation broker (offscreen side): send research.renderPage to the SW
// (the only tier that can drive a tab) and resolve on the matching renderResult.
const RENDER_TIMEOUT_MS = 45_000
let renderSeq = 0
const pendingRenders = new Map<string, (r: Extract<ResearchMsg, { type: 'research.renderResult' }>) => void>()

function makeRenderBroker(taskId: string, signal: AbortSignal): RenderBroker {
  return {
    render(url, want) {
      return new Promise((resolve) => {
        const requestId = `${taskId}:${++renderSeq}`
        const cleanup = () => {
          pendingRenders.delete(requestId)
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
        }
        const timer = setTimeout(() => {
          cleanup()
          resolve({ error: 'render timed out' })
        }, RENDER_TIMEOUT_MS)
        const onAbort = () => {
          cleanup()
          resolve({ error: 'aborted' })
        }
        signal.addEventListener('abort', onAbort, { once: true })
        pendingRenders.set(requestId, (r) => {
          cleanup()
          resolve({ text: r.text, title: r.title, finalUrl: r.finalUrl, screenshotDataUrl: r.screenshotDataUrl, error: r.error })
        })
        chrome.runtime.sendMessage({ type: 'research.renderPage', taskId, requestId, url, want } satisfies ResearchMsg)
      })
    },
  }
}

chrome.runtime.onMessage.addListener((msg: ResearchMsg) => {
  if (msg?.type === 'research.start') {
    const ctrl = new AbortController()
    running.set(msg.taskId, ctrl)
    runResearch({
      taskId: msg.taskId,
      question: msg.question,
      provider: msg.providerConfig,
      modelId: msg.modelId,
      conversationId: msg.conversationId,
      observability: msg.observability,
      signal: ctrl.signal,
      renderBroker: makeRenderBroker(msg.taskId, ctrl.signal),
      onUpdate: (steps, notebook) =>
        chrome.runtime.sendMessage({ type: 'research.update', taskId: msg.taskId, steps, notebook } satisfies ResearchMsg),
    })
      .then(({ report, sources, notebook, verification }) => {
        // The SW already persisted status:'cancelled' when research.cancel fired;
        // a late resolve/reject here must not overwrite that with done/error.
        if (ctrl.signal.aborted) return
        chrome.runtime.sendMessage({
          type: 'research.done',
          taskId: msg.taskId,
          report,
          sources,
          notebook,
          verification,
        } satisfies ResearchMsg)
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return
        chrome.runtime.sendMessage({ type: 'research.error', taskId: msg.taskId, error: err instanceof Error ? err.message : String(err) } satisfies ResearchMsg)
      })
      .finally(() => running.delete(msg.taskId))
  } else if (msg?.type === 'research.cancel') {
    running.get(msg.taskId)?.abort()
    running.delete(msg.taskId)
  } else if (msg?.type === 'research.renderResult') {
    pendingRenders.get(msg.requestId)?.(msg)
  }
})
console.info('[offscreen] research host loaded')
