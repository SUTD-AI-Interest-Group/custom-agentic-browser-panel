// Offscreen document: the headless research host. Only chrome.runtime messaging
// + Web APIs are available here — NO chrome.storage/tabs/notifications.
import type { ResearchMsg } from '../data/researchTasks'
import { runResearch } from '../agent/research'

const running = new Map<string, AbortController>()

chrome.runtime.onMessage.addListener((msg: ResearchMsg) => {
  if (msg?.type === 'research.start') {
    const ctrl = new AbortController()
    running.set(msg.taskId, ctrl)
    runResearch({
      taskId: msg.taskId,
      question: msg.question,
      provider: msg.providerConfig,
      modelId: msg.modelId,
      signal: ctrl.signal,
      onStep: (step) => chrome.runtime.sendMessage({ type: 'research.update', taskId: msg.taskId, step } satisfies ResearchMsg),
    })
      .then(({ report, sources }) => {
        // The SW already persisted status:'cancelled' when research.cancel fired;
        // a late resolve/reject here must not overwrite that with done/error.
        if (ctrl.signal.aborted) return
        chrome.runtime.sendMessage({ type: 'research.done', taskId: msg.taskId, report, sources } satisfies ResearchMsg)
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return
        chrome.runtime.sendMessage({ type: 'research.error', taskId: msg.taskId, error: err instanceof Error ? err.message : String(err) } satisfies ResearchMsg)
      })
      .finally(() => running.delete(msg.taskId))
  } else if (msg?.type === 'research.cancel') {
    running.get(msg.taskId)?.abort()
    running.delete(msg.taskId)
  }
})
console.info('[offscreen] research host loaded')
