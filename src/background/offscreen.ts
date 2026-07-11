// Offscreen document: the headless research host. Only chrome.runtime messaging
// + Web APIs are available here — NO chrome.storage/tabs/notifications.
import type { ResearchMsg } from '../data/researchTasks'
import { runResearch } from '../agent/research'
import type { ProviderConfig } from '../data/settings'

const running = new Map<string, AbortController>()

chrome.runtime.onMessage.addListener((msg: ResearchMsg) => {
  if (msg?.type === 'research.start') {
    const ctrl = new AbortController()
    running.set(msg.taskId, ctrl)
    runResearch({
      taskId: msg.taskId,
      question: msg.question,
      provider: msg.providerConfig as ProviderConfig,
      modelId: msg.modelId,
      signal: ctrl.signal,
      onStep: (step) => chrome.runtime.sendMessage({ type: 'research.update', taskId: msg.taskId, step } satisfies ResearchMsg),
    })
      .then(({ report, sources }) => chrome.runtime.sendMessage({ type: 'research.done', taskId: msg.taskId, report, sources } satisfies ResearchMsg))
      .catch((err) => chrome.runtime.sendMessage({ type: 'research.error', taskId: msg.taskId, error: err instanceof Error ? err.message : String(err) } satisfies ResearchMsg))
      .finally(() => running.delete(msg.taskId))
  } else if (msg?.type === 'research.cancel') {
    running.get(msg.taskId)?.abort()
    running.delete(msg.taskId)
  }
})
console.info('[offscreen] research host loaded')
