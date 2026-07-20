// Offscreen document: the headless research host. Only chrome.runtime messaging
// + Web APIs are available here — NO chrome.storage/tabs/notifications.
import type { BrowseOp, BrowseResult, ResearchMsg } from '../data/researchTasks'
import { runResearch } from '../agent/research'
import type { BrowseBroker, RenderBroker, SearchBroker } from '../tools/research'

const running = new Map<string, AbortController>()

// While a task runs, bump its `updatedAt` on this cadence so the SW watchdog can
// distinguish a live worker from a dead one even across a long, quiet model call.
const HEARTBEAT_MS = 20_000

// Tab brokers (offscreen side): the offscreen host cannot touch tabs, so both the
// one-shot render and the interactive browse session are round-trips to the SW —
// send a request, resolve on the matching result by requestId.
const RENDER_TIMEOUT_MS = 45_000
// A browse op includes a navigation + settle + snapshot, so it gets more runway.
const BROWSE_TIMEOUT_MS = 60_000
// A tab search is one navigation + settle + scrape.
const SEARCH_TIMEOUT_MS = 45_000
let requestSeq = 0
const pendingRenders = new Map<string, (r: Extract<ResearchMsg, { type: 'research.renderResult' }>) => void>()
const pendingBrowses = new Map<string, (r: BrowseResult) => void>()
const pendingSearches = new Map<string, (r: Extract<ResearchMsg, { type: 'research.searchTabResult' }>) => void>()

/**
 * Shared request/response plumbing for both brokers: correlate on a fresh
 * requestId, resolve with `onTimeout`'s value if the SW never answers, and settle
 * immediately on abort so a cancelled task doesn't hang on a dead tab.
 */
function roundTrip<T>(
  pending: Map<string, (r: any) => void>,
  taskId: string,
  signal: AbortSignal,
  timeoutMs: number,
  send: (requestId: string) => void,
  timedOut: T,
  aborted: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const requestId = `${taskId}:${++requestSeq}`
    const cleanup = () => {
      pending.delete(requestId)
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(timedOut)
    }, timeoutMs)
    const onAbort = () => {
      cleanup()
      resolve(aborted)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.set(requestId, (r) => {
      cleanup()
      resolve(r)
    })
    send(requestId)
  })
}

function makeRenderBroker(taskId: string, signal: AbortSignal): RenderBroker {
  return {
    render(url, want) {
      return roundTrip(
        pendingRenders,
        taskId,
        signal,
        RENDER_TIMEOUT_MS,
        (requestId) =>
          chrome.runtime.sendMessage({ type: 'research.renderPage', taskId, requestId, url, want } satisfies ResearchMsg),
        { error: 'render timed out' },
        { error: 'aborted' },
      ).then((r: any) =>
        r.error !== undefined && r.text === undefined
          ? { error: r.error }
          : { text: r.text, title: r.title, finalUrl: r.finalUrl, screenshotDataUrl: r.screenshotDataUrl, error: r.error },
      )
    },
  }
}

function makeBrowseBroker(taskId: string, signal: AbortSignal): BrowseBroker {
  return {
    step(sessionId: string, op: BrowseOp) {
      return roundTrip<BrowseResult>(
        pendingBrowses,
        taskId,
        signal,
        BROWSE_TIMEOUT_MS,
        (requestId) =>
          chrome.runtime.sendMessage({ type: 'research.browse', taskId, requestId, sessionId, op } satisfies ResearchMsg),
        { ok: false, message: 'the browser did not respond in time' },
        { ok: false, message: 'the research task was cancelled' },
      )
    },
  }
}

function makeSearchBroker(taskId: string, signal: AbortSignal): SearchBroker {
  return {
    search(query: string, maxResults: number) {
      return roundTrip(
        pendingSearches,
        taskId,
        signal,
        SEARCH_TIMEOUT_MS,
        (requestId) =>
          chrome.runtime.sendMessage({ type: 'research.searchTab', taskId, requestId, query, maxResults } satisfies ResearchMsg),
        { error: 'tab search timed out' },
        { error: 'aborted' },
      ).then((r: any) => (r.error !== undefined ? { error: r.error } : { results: r.results ?? [] }))
    },
  }
}

chrome.runtime.onMessage.addListener((msg: ResearchMsg) => {
  if (msg?.type === 'research.start') {
    // Double-run guard: the SW watchdog re-dispatches stranded tasks, but a task
    // already running here (including one merely paused-and-sleeping between retries,
    // whose promise is still pending so it stays in `running`) must never be run
    // twice. A redundant dispatch for a live task is simply ignored.
    if (running.has(msg.taskId)) return
    const ctrl = new AbortController()
    running.set(msg.taskId, ctrl)
    const heartbeat = setInterval(() => {
      if (ctrl.signal.aborted) return
      void chrome.runtime.sendMessage({ type: 'research.heartbeat', taskId: msg.taskId } satisfies ResearchMsg).catch(() => {})
    }, HEARTBEAT_MS)
    runResearch({
      taskId: msg.taskId,
      question: msg.question,
      provider: msg.providerConfig,
      modelId: msg.modelId,
      conversationId: msg.conversationId,
      observability: msg.observability,
      signal: ctrl.signal,
      deadlineAt: msg.deadlineAt,
      resumeNotebook: msg.notebook,
      renderBroker: makeRenderBroker(msg.taskId, ctrl.signal),
      browseBroker: makeBrowseBroker(msg.taskId, ctrl.signal),
      searchBroker: makeSearchBroker(msg.taskId, ctrl.signal),
      onUpdate: (steps, notebook) =>
        chrome.runtime.sendMessage({ type: 'research.update', taskId: msg.taskId, steps, notebook } satisfies ResearchMsg),
      // Transient-failure transitions drive the UI's paused/waiting state.
      onPause: ({ reason, nextRetryAt }) =>
        void chrome.runtime
          .sendMessage({ type: 'research.paused', taskId: msg.taskId, reason, nextRetryAt } satisfies ResearchMsg)
          .catch(() => {}),
      onResume: () =>
        void chrome.runtime.sendMessage({ type: 'research.resumed', taskId: msg.taskId } satisfies ResearchMsg).catch(() => {}),
    })
      .then(({ report, sources, notebook, verification, partial }) => {
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
          partial,
        } satisfies ResearchMsg)
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return
        chrome.runtime.sendMessage({ type: 'research.error', taskId: msg.taskId, error: err instanceof Error ? err.message : String(err) } satisfies ResearchMsg)
      })
      .finally(() => {
        clearInterval(heartbeat)
        running.delete(msg.taskId)
      })
  } else if (msg?.type === 'research.cancel') {
    running.get(msg.taskId)?.abort()
    running.delete(msg.taskId)
  } else if (msg?.type === 'research.renderResult') {
    pendingRenders.get(msg.requestId)?.(msg)
  } else if (msg?.type === 'research.browseResult') {
    pendingBrowses.get(msg.requestId)?.(msg.result)
  } else if (msg?.type === 'research.searchTabResult') {
    pendingSearches.get(msg.requestId)?.(msg)
  }
})
console.info('[offscreen] research host loaded')
