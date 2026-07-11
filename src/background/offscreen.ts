// Offscreen document: the headless research host. Only chrome.runtime messaging
// + Web APIs are available here — NO chrome.storage/tabs/notifications.
import type { ResearchMsg } from '../data/researchTasks'

chrome.runtime.onMessage.addListener((msg: ResearchMsg) => {
  if (msg?.type === 'research.start') {
    // Task 10 replaces this with the real research loop.
    chrome.runtime.sendMessage({ type: 'research.error', taskId: msg.taskId, error: 'offscreen not implemented yet' } satisfies ResearchMsg)
  }
  if (msg?.type === 'research.cancel') { /* Task 10 */ }
})
console.info('[offscreen] research host loaded')
